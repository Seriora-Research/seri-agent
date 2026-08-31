import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { LanguageModelUsage } from "ai";
import type { LoopEvent } from "../loop/loop";
import type { CostReport } from "../provider/cost";
import { configDirForStore, DATABASE_FILENAME, SessionDatabase } from "../session/database";
import type { ChildEventPayload } from "../subagents/dispatch";
import { writeFileVerification } from "../verify/outcome";
import { pruneTrajectories } from "./prune";
import {
  TRAJECTORY_SCHEMA_VERSION,
  type TrajectoryActor,
  type TrajectoryHeader,
  type TrajectoryKind,
  type TrajectoryRecord,
} from "./schema";
import { capJson, classifyEditError, summarizeArgs, summarizeResult } from "./summarize";

export type CheckpointOp = Extract<TrajectoryKind, { kind: "checkpoint" }>["op"];

export type TrajectoryWriter = {
  recordLoopEvent: (event: LoopEvent) => void;
  recordChildUsage: (usage: LanguageModelUsage, cost: CostReport | undefined) => void;
  recordChildEvent: (payload: ChildEventPayload) => void;
  recordCheckpoint: (entry: { op: CheckpointOp; tool?: string; toolCallId?: string }) => void;
  recordArchivist: (
    report: { usage: LanguageModelUsage; cost: CostReport | undefined } | undefined,
  ) => void;
  setEnabled: (enabled: boolean) => void;
  isEnabled: () => boolean;
};

type WriterOpts = {
  dir: string;
  sessionId: string;
  cwd: string;
  model?: string;
  provider?: string;
  enabled: boolean;
  retentionDays: number;
  now?: () => Date;
  onWarning: (message: string) => void;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readTrajectory(path: string): unknown[] {
  const trajectoriesDir = dirname(path);
  const configDir = configDirForStore(trajectoriesDir, "trajectories");
  if (existsSync(join(configDir, DATABASE_FILENAME))) {
    const database = new SessionDatabase(configDir);
    try {
      database.importLegacyTrajectories(trajectoriesDir);
      const name = basename(path);
      const sessionId = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
      return database.readTrajectory(sessionId);
    } finally {
      database.close();
    }
  }
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

export function createTrajectoryWriter(opts: WriterOpts): TrajectoryWriter {
  const now = opts.now ?? (() => new Date());
  let enabled = opts.enabled;
  let lastWritePath: string | undefined;
  let header: TrajectoryHeader | undefined;
  const parent: TrajectoryActor = { type: "parent" };

  function prune(keepSessionId?: string): void {
    try {
      pruneTrajectories(opts.dir, {
        now: now(),
        retentionDays: opts.retentionDays,
        ...(keepSessionId !== undefined ? { keepSessionId } : {}),
      });
    } catch (err) {
      opts.onWarning(`could not prune trajectories: ${messageOf(err)}`);
    }
  }
  prune(opts.sessionId);

  function writeRecord(kind: TrajectoryKind, actor: TrajectoryActor = parent): void {
    if (!enabled) return;
    try {
      header ??= {
        v: TRAJECTORY_SCHEMA_VERSION,
        kind: "header",
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        startedAt: now().toISOString(),
        model: opts.model,
        provider: opts.provider,
      };
      const database = new SessionDatabase(configDirForStore(opts.dir, "trajectories"));
      try {
        database.importLegacyTrajectories(opts.dir);
        database.appendTrajectory(header, {
          v: TRAJECTORY_SCHEMA_VERSION,
          ts: now().toISOString(),
          sessionId: opts.sessionId,
          actor,
          ...kind,
        } as Omit<TrajectoryRecord, "seq">);
      } finally {
        database.close();
      }
    } catch (err) {
      opts.onWarning(`could not write trajectory: ${messageOf(err)}`);
    }
  }

  function recordLoopEvent(event: LoopEvent, actor: TrajectoryActor = parent): void {
    if (event.type === "text-delta" || event.type === "messages-updated") return;
    if (event.type === "tool-call") {
      if (
        event.name === "write_file" &&
        isRecord(event.args) &&
        typeof event.args.path === "string"
      ) {
        lastWritePath = event.args.path;
      }
      const summarized = summarizeArgs(event.name, event.args);
      writeRecord(
        {
          kind: "tool_call",
          name: event.name,
          args: summarized.value,
          argsElided: summarized.elided,
        },
        actor,
      );
      return;
    }
    if (event.type === "tool-result") {
      const summarized = summarizeResult(event.name, event.result);
      writeRecord(
        {
          kind: "tool_result",
          name: event.name,
          result: summarized.value,
          resultElided: summarized.elided,
        },
        actor,
      );
      const verification =
        event.name === "write_file" ? writeFileVerification(event.result) : undefined;
      if (verification !== undefined) {
        writeRecord(
          { kind: "check_result", path: lastWritePath ?? "", outcome: verification },
          actor,
        );
      }
      if (event.name === "edit" && typeof event.result === "string") {
        writeRecord(
          { kind: "edit_outcome", status: "ok", bytes: Buffer.byteLength(event.result) },
          actor,
        );
      }
      return;
    }
    if (event.type === "permission-denied") {
      writeRecord({ kind: "denial", name: event.name, reason: event.reason }, actor);
      return;
    }
    if (event.type === "usage") {
      writeRecord({ kind: "usage", usage: event.usage, cost: event.cost, source: "turn" }, actor);
      return;
    }
    if (event.type === "compacted") {
      writeRecord({ kind: "compacted", evictedCount: event.evictedCount }, actor);
      writeRecord({ kind: "usage", usage: event.usage, source: "compaction" }, actor);
      return;
    }
    if (event.type === "retry") {
      writeRecord({ kind: "retry", attempt: event.attempt }, actor);
      return;
    }
    if (event.type === "tool-allowed") {
      writeRecord({ kind: "tool_allowed", name: event.name }, actor);
      return;
    }
    if (event.type === "done") {
      writeRecord({ kind: "done", reason: event.reason }, actor);
      return;
    }
    if (event.type === "error") {
      const capped = capJson(event.error);
      writeRecord(
        {
          kind: "error",
          error: typeof capped.value === "string" ? capped.value : event.error.slice(0, 8192),
          errorElided: capped.elided,
        },
        actor,
      );
      const status = classifyEditError(event.error);
      if (status !== "error") writeRecord({ kind: "edit_outcome", status }, actor);
    }
  }

  return {
    recordLoopEvent: (event) => recordLoopEvent(event),
    recordChildUsage: (usage, cost) => {
      writeRecord({
        kind: "usage",
        usage,
        cost,
        source: "child",
      });
    },
    recordChildEvent: (payload) => {
      if (payload.event.type === "child-started") return;
      if (payload.event.type === "text-delta") return;
      if (payload.event.type === "usage") return;
      recordLoopEvent(payload.event, {
        type: "child",
        childId: payload.childId,
        role: payload.role,
      });
    },
    recordCheckpoint: (entry) => {
      writeRecord({
        kind: "checkpoint",
        op: entry.op,
        tool: entry.tool,
        toolCallId: entry.toolCallId,
      });
    },
    recordArchivist: (report) => {
      if (report === undefined) return;
      writeRecord(
        { kind: "usage", usage: report.usage, cost: report.cost, source: "archivist" },
        { type: "archivist" },
      );
    },
    setEnabled: (next) => {
      enabled = next;
      if (!next) prune(opts.sessionId);
    },
    isEnabled: () => enabled,
  };
}
