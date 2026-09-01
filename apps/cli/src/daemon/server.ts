import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { DaemonDescriptor, DaemonEvent, PublicLoopEvent } from "@seri/daemon-client";
import type { CliDeps } from "../cli";
import { SessionDatabase } from "../session/database";
import {
  type AcquiredDaemonLock,
  acquireDaemonLock,
  removeOwnedDescriptor,
  writeDaemonDescriptor,
} from "./descriptor";
import { flushIdleSession } from "./idle";
import { approvalBodySchema, turnRequestSchema } from "./protocol";
import { createRunScheduled } from "./scheduled";
import { type RunScheduled, Scheduler, ScheduleValidationError } from "./scheduler";
import { DaemonSessionManager, type ExecuteTurn, SessionNotFoundError } from "./sessionManager";
import { createAttendedExecuteTurn } from "./turn";

export type { ExecuteTurn, ExecuteTurnInput } from "./sessionManager";

export type StartedDaemon = {
  endpoint: string;
  token: string;
  pid: number;
  scheduler: Scheduler;
  stop: () => Promise<void>;
};

export type StartDaemonOptions = {
  configDir: string;
  executeTurn?: ExecuteTurn;
  runScheduled?: RunScheduled;
  deps?: CliDeps;
  now?: () => number;
  tickMs?: number;
  idleMs?: number;
  onIdleFlush?: (sessionId: string, signal: AbortSignal) => Promise<void>;
};

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function hasBearer(header: string | null, token: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const got = header.slice("Bearer ".length);
  const expected = Buffer.from(token);
  const actual = Buffer.from(got);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function sseResponse(
  subscribe: (send: (event: DaemonEvent) => void) => (() => void) | undefined,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const closeOnce = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          return;
        }
      };
      const send = (event: DaemonEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          return;
        }
        if (event.event.type === "turn-complete") closeOnce();
      };
      const unsubscribe = subscribe(send);
      if (unsubscribe === undefined) {
        closeOnce();
        return;
      }
      const onAbort = () => {
        unsubscribe();
        closeOnce();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export async function defaultExecuteTurn(input: {
  emitLoop: (event: { type: string } & Record<string, unknown>) => void;
}): Promise<{ exitCode: 0 | 1 }> {
  input.emitLoop({ type: "text-delta", text: "" } satisfies PublicLoopEvent);
  input.emitLoop({ type: "done", reason: "no-tool-call" });
  return { exitCode: 0 };
}

export async function startDaemon(opts: StartDaemonOptions): Promise<StartedDaemon> {
  const lock: AcquiredDaemonLock = acquireDaemonLock(opts.configDir);
  const token = randomBytes(32).toString("hex");
  let database: SessionDatabase;
  try {
    database = new SessionDatabase(opts.configDir);
  } catch (error) {
    lock.release();
    throw error;
  }
  const deps: CliDeps = {
    ...opts.deps,
    authConfigDir: opts.deps?.authConfigDir ?? opts.configDir,
  };
  const sessionsDir = deps.sessionsDir ?? join(opts.configDir, "sessions");
  const checkpointsDir = deps.checkpointsDir ?? join(opts.configDir, "checkpoints");
  const permissionsDir = deps.permissionsDir ?? opts.configDir;
  let scheduler: Scheduler;
  let manager: DaemonSessionManager;
  let server: ReturnType<typeof Bun.serve>;
  try {
    database.importLegacySessions(sessionsDir);
    database.importLegacyTrajectories(join(opts.configDir, "trajectories"));
    const executeTurn =
      opts.executeTurn ??
      createAttendedExecuteTurn({
        configDir: opts.configDir,
        sessionsDir,
        checkpointsDir,
        permissionsDir,
        deps,
        database,
      });
    const runScheduled =
      opts.runScheduled ??
      createRunScheduled({
        configDir: opts.configDir,
        sessionsDir,
        deps,
        database,
      });
    const onIdleFlush =
      opts.onIdleFlush ??
      ((sessionId: string, signal: AbortSignal) =>
        flushIdleSession(database, sessionId, opts.configDir, deps, signal));
    manager = new DaemonSessionManager(database, executeTurn, {
      idleMs: opts.idleMs,
      onIdleFlush,
    });
    scheduler = new Scheduler(database, runScheduled, opts.now, opts.tickMs);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (req) => {
        if (!hasBearer(req.headers.get("authorization"), token)) return unauthorized();

        const url = new URL(req.url);
        const path = url.pathname;

        if (req.method === "GET" && path === "/v1/health") {
          return json(200, { v: 1, pid: process.pid });
        }

        if (req.method === "POST" && path === "/v1/turns") {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return json(400, { error: "invalid json" });
          }
          const parsed = turnRequestSchema.safeParse(body);
          if (!parsed.success) return json(400, { error: "invalid turn request" });
          try {
            const started = await manager.startTurn(parsed.data);
            return sseResponse(started.subscribe, req.signal);
          } catch (error) {
            if (error instanceof SessionNotFoundError) return json(404, { error: error.message });
            throw error;
          }
        }

        const eventsMatch = path.match(/^\/v1\/turns\/([^/]+)\/events$/);
        if (req.method === "GET" && eventsMatch !== null) {
          const turnId = decodeURIComponent(eventsMatch[1]!);
          const after = Number.parseInt(url.searchParams.get("after") ?? "-1", 10);
          const afterSeq = Number.isInteger(after) ? after : -1;
          if (manager.getTurn(turnId) === undefined && !database.hasTurn(turnId)) {
            return json(404, { error: "turn not found" });
          }
          return sseResponse((send) => manager.replayAndFollow(turnId, afterSeq, send), req.signal);
        }

        const approvalMatch = path.match(/^\/v1\/turns\/([^/]+)\/approvals\/([^/]+)$/);
        if (req.method === "POST" && approvalMatch !== null) {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return json(400, { error: "invalid json" });
          }
          const parsed = approvalBodySchema.safeParse(body);
          if (!parsed.success) return json(400, { error: "invalid approval" });
          const turnId = decodeURIComponent(approvalMatch[1]!);
          const requestId = decodeURIComponent(approvalMatch[2]!);
          if (!manager.resolveApproval(turnId, requestId, parsed.data.answer)) {
            return json(404, { error: "approval not found" });
          }
          return json(200, { ok: true });
        }

        const cancelMatch = path.match(/^\/v1\/turns\/([^/]+)\/cancel$/);
        if (req.method === "POST" && cancelMatch !== null) {
          const turnId = decodeURIComponent(cancelMatch[1]!);
          if (!manager.cancelTurn(turnId)) return json(404, { error: "turn not found" });
          return json(200, { ok: true });
        }

        if (req.method === "GET" && path === "/v1/sessions/search") {
          const q = url.searchParams.get("q") ?? "";
          const cwd = url.searchParams.get("cwd") ?? undefined;
          const sessionId = url.searchParams.get("sessionId") ?? undefined;
          return json(200, {
            results: database.searchSessions(q, { cwd, sessionId }),
          });
        }

        if (req.method === "POST" && path === "/v1/schedules") {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return json(400, { error: "invalid json" });
          }
          try {
            const created = scheduler.create(body);
            return json(201, created);
          } catch (error) {
            if (error instanceof ScheduleValidationError) {
              return json(400, { error: error.message });
            }
            throw error;
          }
        }

        if (req.method === "GET" && path === "/v1/schedules") {
          return json(200, { schedules: database.listSchedules() });
        }

        const scheduleRunsMatch = path.match(/^\/v1\/schedules\/([^/]+)\/runs$/);
        if (req.method === "GET" && scheduleRunsMatch !== null) {
          const id = decodeURIComponent(scheduleRunsMatch[1]!);
          if (database.getSchedule(id) === undefined)
            return json(404, { error: "schedule not found" });
          return json(200, { runs: database.listScheduleRuns(id) });
        }

        const scheduleMatch = path.match(/^\/v1\/schedules\/([^/]+)$/);
        if (req.method === "DELETE" && scheduleMatch !== null) {
          const id = decodeURIComponent(scheduleMatch[1]!);
          if (!database.disableSchedule(id)) return json(404, { error: "schedule not found" });
          return json(200, { ok: true });
        }

        return json(404, { error: "not found" });
      },
    });
  } catch (error) {
    database.close();
    lock.release();
    throw error;
  }

  const endpoint = `http://127.0.0.1:${server.port}`;
  const descriptor: DaemonDescriptor = {
    v: 1,
    endpoint,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  try {
    writeDaemonDescriptor(opts.configDir, descriptor);
    scheduler.start();
  } catch (error) {
    scheduler.stop();
    server.stop(true);
    database.close();
    lock.release();
    throw error;
  }

  return {
    endpoint,
    token,
    pid: process.pid,
    scheduler,
    stop: async () => {
      scheduler.stop();
      server.stop(true);
      manager.cancelAll();
      await manager.waitForIdle();
      database.close();
      removeOwnedDescriptor(opts.configDir, token);
      lock.release();
    },
  };
}
