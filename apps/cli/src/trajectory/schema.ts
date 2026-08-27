import type { CheckOutcome } from "../verify/outcome";
import type { LanguageModelUsage } from "ai";
import type { CostReport } from "../provider/cost";

export const TRAJECTORY_SCHEMA_VERSION = 1;

export type Elision = { elided: true; originalBytes: number };

export type TrajectoryActor =
  | { type: "parent" }
  | { type: "child"; childId: string; role: string }
  | { type: "archivist" };

export type TrajectoryHeader = {
  v: typeof TRAJECTORY_SCHEMA_VERSION;
  kind: "header";
  sessionId: string;
  cwd: string;
  startedAt: string;
  model?: string;
  provider?: string;
};

export type EditOutcomeStatus = "ok" | "near_miss" | "ambiguous" | "disproportionate" | "error";

export type TrajectoryKind =
  | { kind: "tool_call"; name: string; args: unknown; argsElided?: Elision }
  | { kind: "tool_result"; name: string; result: unknown; resultElided?: Elision }
  | { kind: "check_result"; path: string; outcome: CheckOutcome }
  | { kind: "edit_outcome"; status: EditOutcomeStatus; bytes?: number }
  | {
      kind: "checkpoint";
      op: "snapshot" | "ignored" | "compaction-barrier" | "rewind-barrier" | "pre-undo";
      tool?: string;
      toolCallId?: string;
    }
  | { kind: "denial"; name: string; reason: "blocked" | "declined" }
  | {
      kind: "usage";
      usage: LanguageModelUsage;
      cost?: CostReport;
      source: "turn" | "compaction" | "child" | "archivist";
    }
  | { kind: "done"; reason: "no-tool-call" | "max-iterations" | "aborted" | "repeated-denials" }
  | { kind: "error"; error: string; errorElided?: Elision }
  | { kind: "retry"; attempt: number }
  | { kind: "tool_allowed"; name: string }
  | { kind: "compacted"; evictedCount: number };

export type TrajectoryRecord = {
  v: typeof TRAJECTORY_SCHEMA_VERSION;
  ts: string;
  seq: number;
  sessionId: string;
  actor: TrajectoryActor;
} & TrajectoryKind;
