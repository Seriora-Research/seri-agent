export const SCHEDULE_FAILURE_BACKOFF_AFTER = 2;
export const SCHEDULE_FAILURE_PAUSE_AFTER = 3;

export type ScheduleTiming =
  | { kind: "once"; at: string }
  | { kind: "interval"; everySeconds: number };

export type ScheduleCadence = {
  consecutiveFailures: number;
  pauseReason: string | null;
  nextRunAtMs: number | null;
  enabled: boolean;
  runStatus: "complete" | "error" | "paused";
};

export function advanceInterval(nextRunAtMs: number, everyMs: number, nowMs: number): number {
  if (nextRunAtMs > nowMs) return nextRunAtMs;
  return nextRunAtMs + (Math.floor((nowMs - nextRunAtMs) / everyMs) + 1) * everyMs;
}

export function scheduleFailureDelayMs(everySeconds: number, consecutiveFailures: number): number {
  const base = everySeconds * 1000;
  if (consecutiveFailures < SCHEDULE_FAILURE_BACKOFF_AFTER) return base;
  const exp = consecutiveFailures - SCHEDULE_FAILURE_BACKOFF_AFTER + 1;
  return base * 2 ** exp;
}

export function consumeSlot(
  timing: ScheduleTiming,
  slotMs: number,
  nowMs: number,
): { enabled: boolean; nextRunAtMs: number | null } {
  if (timing.kind === "once") return { enabled: false, nextRunAtMs: null };
  return { enabled: true, nextRunAtMs: advanceInterval(slotMs, timing.everySeconds * 1000, nowMs) };
}

export function cadenceAfterFire(input: {
  timing: ScheduleTiming;
  consecutiveFailures: number;
  slotMs: number;
  failed: boolean;
  error: string | null;
  nowMs: number;
}): ScheduleCadence {
  const consecutiveFailures = input.failed ? input.consecutiveFailures + 1 : 0;
  if (input.timing.kind === "once" || !input.failed) {
    return {
      ...consumeSlot(input.timing, input.slotMs, input.nowMs),
      consecutiveFailures,
      pauseReason: null,
      runStatus: input.failed ? "error" : "complete",
    };
  }
  const error = input.error ?? "scheduled run failed";
  if (consecutiveFailures >= SCHEDULE_FAILURE_PAUSE_AFTER) {
    return {
      consecutiveFailures,
      pauseReason: error,
      nextRunAtMs: null,
      enabled: false,
      runStatus: "paused",
    };
  }
  return {
    consecutiveFailures,
    pauseReason: null,
    nextRunAtMs: advanceInterval(
      input.slotMs,
      scheduleFailureDelayMs(input.timing.everySeconds, consecutiveFailures),
      input.nowMs,
    ),
    enabled: true,
    runStatus: "error",
  };
}
