import { randomUUID } from "node:crypto";
import type { ScheduleRequest, ScheduleTiming } from "@seri/daemon-client";
import {
  createScheduledToolDefinitions,
  DISPATCH_TOOL_NAME,
  READ_ONLY_TOOL_NAMES,
  WRITE_TOOL_NAMES,
} from "../provider/tools";
import { TODO_TOOL_NAME } from "../todo/tool";
import type { RunPolicy } from "../runtime/types";
import type { ScheduleRecord, SessionDatabase } from "../session/database";
import type { SessionState } from "../session/session";

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export type ScheduledRunInput = {
  scheduleId: string;
  session: SessionState;
  tools: ReturnType<typeof createScheduledToolDefinitions>;
  policy: Extract<RunPolicy, { origin: "scheduled" }>;
};

export type RunScheduled = (
  input: ScheduledRunInput,
) => Promise<{ response?: string; error?: string }>;

export function scheduledRunPolicy(): Extract<RunPolicy, { origin: "scheduled" }> {
  return {
    origin: "scheduled",
    permissionMode: "read-only",
    allowedTools: [],
  };
}

export function assertScheduledToolset(
  tools: Record<string, unknown>,
): asserts tools is ReturnType<typeof createScheduledToolDefinitions> {
  const names = Object.keys(tools).sort();
  const expected = [...READ_ONLY_TOOL_NAMES].sort();
  if (names.join("\0") !== expected.join("\0")) {
    throw new Error(
      `scheduled tools must be exactly ${expected.join(", ")}; got ${names.join(", ")}`,
    );
  }
  for (const name of WRITE_TOOL_NAMES) {
    if (name in tools) throw new Error(`scheduled tools must not include ${name}`);
  }
  if (DISPATCH_TOOL_NAME in tools) {
    throw new Error("scheduled tools must not include dispatch_subagents");
  }
  if (TODO_TOOL_NAME in tools) {
    throw new Error("scheduled tools must not include todo");
  }
  if ("memory_write" in tools) {
    throw new Error("scheduled tools must not include memory_write");
  }
}

export function parseScheduleRequest(body: unknown): ScheduleRequest {
  if (typeof body !== "object" || body === null) {
    throw new ScheduleValidationError("invalid schedule request");
  }
  const record = body as Record<string, unknown>;
  if (record.origin === "scheduled") {
    throw new ScheduleValidationError("schedule creation cannot carry origin scheduled");
  }
  if (record.allowModelReads !== true) {
    throw new ScheduleValidationError("allowModelReads must be true");
  }
  if (typeof record.task !== "string" || record.task.length === 0) {
    throw new ScheduleValidationError("task is required");
  }
  if (typeof record.cwd !== "string" || record.cwd.length === 0) {
    throw new ScheduleValidationError("cwd is required");
  }
  const timing = parseTiming(record.timing);
  return {
    task: record.task,
    cwd: record.cwd,
    timing,
    allowModelReads: true,
  };
}

function parseTiming(value: unknown): ScheduleTiming {
  if (typeof value !== "object" || value === null) {
    throw new ScheduleValidationError("timing is required");
  }
  const timing = value as Record<string, unknown>;
  if (timing.kind === "once") {
    if (typeof timing.at !== "string" || !ISO_WITH_OFFSET.test(timing.at)) {
      throw new ScheduleValidationError(
        "once schedules require an ISO timestamp with an explicit offset",
      );
    }
    if (!Number.isFinite(Date.parse(timing.at))) {
      throw new ScheduleValidationError("once schedules require a valid ISO timestamp");
    }
    return { kind: "once", at: timing.at };
  }
  if (timing.kind === "interval") {
    if (
      typeof timing.everySeconds !== "number" ||
      !Number.isInteger(timing.everySeconds) ||
      timing.everySeconds < 1
    ) {
      throw new ScheduleValidationError(
        "interval schedules require a positive whole number of seconds",
      );
    }
    return { kind: "interval", everySeconds: timing.everySeconds };
  }
  throw new ScheduleValidationError("timing kind must be once or interval");
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly database: SessionDatabase,
    private readonly runScheduled: RunScheduled,
    private readonly now: () => number = () => Date.now(),
    private readonly tickMs = 60_000,
  ) {}

  start(): void {
    this.database.skipMissedSchedules(this.now());
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  create(request: unknown): ScheduleRecord {
    const parsed = parseScheduleRequest(request);
    const now = this.now();
    const nextRunAtMs =
      parsed.timing.kind === "once"
        ? Date.parse(parsed.timing.at)
        : now + parsed.timing.everySeconds * 1000;
    const id = randomUUID();
    this.database.insertSchedule({
      id,
      task: parsed.task,
      cwd: parsed.cwd,
      timingJson: JSON.stringify(parsed.timing),
      nextRunAtMs,
      enabled: 1,
      createdAt: new Date(now).toISOString(),
    });
    return this.database.getSchedule(id)!;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const due of this.database.listDueSchedules(now)) {
        const claimed = this.database.claimSchedule(due.id, now);
        if (claimed === undefined) continue;
        try {
          await this.fire(claimed);
        } finally {
          this.database.clearScheduleRunning(claimed.id);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private mintScheduledSession(schedule: ScheduleRecord): SessionState | undefined {
    const session: SessionState = {
      id: randomUUID(),
      cwd: schedule.cwd,
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [],
    };
    try {
      this.database.saveSession(session);
      session.messages = [{ role: "user", content: schedule.task }];
      this.database.saveSession(session);
      return session;
    } catch {
      return undefined;
    }
  }

  private async fire(schedule: ScheduleRecord): Promise<void> {
    const session = this.mintScheduledSession(schedule);
    if (session === undefined) return;

    const startedAt = new Date(this.now()).toISOString();
    const runId = randomUUID();
    const commit = (status: string, response: string | null, error: string | null): void => {
      this.database.commitScheduleFire(
        {
          id: runId,
          scheduleId: schedule.id,
          sessionId: session.id,
          status,
          response,
          error,
          startedAt,
          finishedAt: new Date(this.now()).toISOString(),
        },
        this.now(),
      );
    };
    try {
      const tools = createScheduledToolDefinitions(schedule.cwd);
      assertScheduledToolset(tools);
      const policy = scheduledRunPolicy();
      const result = await this.runScheduled({
        scheduleId: schedule.id,
        session,
        tools,
        policy,
      });
      commit(
        result.error === undefined ? "complete" : "error",
        result.response ?? null,
        result.error ?? null,
      );
    } catch (error) {
      commit("error", null, error instanceof Error ? error.message : String(error));
    }
  }
}
