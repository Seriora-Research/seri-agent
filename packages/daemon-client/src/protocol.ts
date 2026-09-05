export type PermissionModeWire = "read-only" | "approve-each";

export type ApprovalAnswer = "once" | "always" | "no";

export type TurnRequest = {
  task: string;
  sessionId?: string;
  cwd?: string;
  permissionMode?: PermissionModeWire;
};

export type PublicLoopEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; name: string; args: unknown }
  | { type: "tool-result"; name: string; result: unknown }
  // Mirrors loop.ts's own reason union, including "hook" and "containment". Not caught by the
  // compiler: the daemon launders a LoopEvent through `as PublicLoopEvent` (daemon/sessionManager.ts),
  // so a value this type says cannot occur still goes out on the wire. Add a member here whenever
  // one is added there.
  | { type: "permission-denied"; name: string; reason: "blocked" | "declined" | "hook" | "containment" }
  | { type: "compacted"; summary: unknown; evictedCount: number; usage: unknown }
  | { type: "usage"; usage: unknown; cost?: unknown }
  | { type: "retry"; attempt: number }
  | { type: "tool-allowed"; name: string }
  | { type: "done"; reason: string }
  | { type: "error"; error: string };

export type DaemonEvent = {
  v: 1;
  sessionId: string;
  turnId: string;
  seq: number;
  event:
    | { type: "loop"; value: PublicLoopEvent }
    | { type: "approval-request"; requestId: string; toolName: string; args: unknown }
    | { type: "archivist"; trigger: string; staged: boolean }
    | { type: "turn-complete"; exitCode: 0 | 1 }
    | { type: string; [key: string]: unknown };
};

export type DaemonDescriptor = {
  v: 1;
  endpoint: string;
  token: string;
  pid: number;
  startedAt: string;
};

export type HealthResponse = {
  v: 1;
  pid: number;
};

export type ScheduleTiming =
  | { kind: "once"; at: string }
  | { kind: "interval"; everySeconds: number };

export type ScheduleRequest = {
  task: string;
  cwd: string;
  timing: ScheduleTiming;
  allowModelReads: true;
};

export function isDaemonEnvelope(value: unknown): value is DaemonEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.sessionId === "string" &&
    typeof record.turnId === "string" &&
    typeof record.seq === "number" &&
    Number.isInteger(record.seq) &&
    typeof record.event === "object" &&
    record.event !== null
  );
}

export function isKnownDaemonEvent(event: DaemonEvent["event"]): boolean {
  return (
    event.type === "loop" ||
    event.type === "approval-request" ||
    event.type === "archivist" ||
    event.type === "turn-complete"
  );
}

export function isLoopDaemonEvent(
  event: DaemonEvent["event"],
): event is { type: "loop"; value: PublicLoopEvent } {
  return event.type === "loop" && "value" in event;
}
