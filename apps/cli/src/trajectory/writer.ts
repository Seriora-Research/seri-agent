import {
  appendFileSync as appendFileSyncReal,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { LanguageModelUsage } from "ai";
import { ensureOwnerOnlyDir } from "../atomicWriteFile";
import type { LoopEvent } from "../loop/loop";
import type { CostReport } from "../provider/cost";
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
  appendFileSync?: (path: string, data: string) => void;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readTrajectory(path: string): unknown[] {
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

function maxSeqOf(value: unknown): number {
  if (!isRecord(value) || typeof value.seq !== "number" || !Number.isFinite(value.seq)) return 0;
  return value.seq;
}

function recoverExistingFile(path: string): { seq: number; present: boolean } {
  if (!existsSync(path)) return { seq: 0, present: false };
  const raw = readFileSync(path, "utf8");
  if (raw.length === 0) return { seq: 0, present: false };
  const parts = raw.split("\n");
  const kept: string[] = [];
  let seq = 0;
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    const isLast = i === parts.length - 1;
    if (line === "" && isLast) break;
    try {
      seq = Math.max(seq, maxSeqOf(JSON.parse(line)));
      kept.push(line);
    } catch {
      if (isLast || (i === parts.length - 2 && parts[parts.length - 1] === "")) break;
      kept.push(line);
    }
  }
  if (kept.length === 0) {
    writeFileSync(path, "");
    return { seq: 0, present: false };
  }
  const rewritten = `${kept.join("\n")}\n`;
  if (rewritten !== raw) writeFileSync(path, rewritten);
  return { seq, present: true };
}

export function createTrajectoryWriter(opts: WriterOpts): TrajectoryWriter {
  const now = opts.now ?? (() => new Date());
  const append = opts.appendFileSync ?? appendFileSyncReal;
  const path = join(opts.dir, `${opts.sessionId}.jsonl`);
  let seq = 0;
  let opened = false;
  let enabled = opts.enabled;
  let lastWritePath: string | undefined;
  const parent: TrajectoryActor = { type: "parent" };

  function pruneIfPresent(keepSessionId?: string): void {
    try {
      if (existsSync(opts.dir)) {
        pruneTrajectories(opts.dir, {
          now: now(),
          retentionDays: opts.retentionDays,
          ...(keepSessionId !== undefined ? { keepSessionId } : {}),
        });
      }
    } catch (err) {
      opts.onWarning(`could not prune trajectories: ${messageOf(err)}`);
    }
  }
  if (!enabled) pruneIfPresent(opts.sessionId);

  function writeRecord(kind: TrajectoryKind, actor: TrajectoryActor = parent): void {
    if (!enabled) return;
    try {
      if (!opened) {
        ensureOwnerOnlyDir(opts.dir);
        pruneTrajectories(opts.dir, {
          now: now(),
          retentionDays: opts.retentionDays,
          keepSessionId: opts.sessionId,
        });
        const existing = recoverExistingFile(path);
        seq = existing.seq;
        if (!existing.present) {
          const header: TrajectoryHeader = {
            v: TRAJECTORY_SCHEMA_VERSION,
            kind: "header",
            sessionId: opts.sessionId,
            cwd: opts.cwd,
            startedAt: now().toISOString(),
            model: opts.model,
            provider: opts.provider,
          };
          append(path, `${JSON.stringify(header)}\n`);
        }
        opened = true;
      }
      seq += 1;
      const record: TrajectoryRecord = {
        v: TRAJECTORY_SCHEMA_VERSION,
        ts: now().toISOString(),
        seq,
        sessionId: opts.sessionId,
        actor,
        ...kind,
      };
      append(path, `${JSON.stringify(record)}\n`);
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
      if (!next) pruneIfPresent(opts.sessionId);
    },
    isEnabled: () => enabled,
  };
}
