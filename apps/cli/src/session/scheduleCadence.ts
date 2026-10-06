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

export function cadenceAfterFire(input: {
  timing: ScheduleTiming;
  consecutiveFailures: number;
  nextRunAtMs: number | null;
  failed: boolean;
  error: string | null;
  nowMs: number;
}): ScheduleCadence {
  const consecutiveFailures = input.failed ? input.consecutiveFailures + 1 : 0;
  if (input.timing.kind === "once") {
    return {
      consecutiveFailures,
      pauseReason: null,
      nextRunAtMs: null,
      enabled: false,
      runStatus: input.failed ? "error" : "complete",
    };
  }
  if (!input.failed) {
    return {
      consecutiveFailures: 0,
      pauseReason: null,
      nextRunAtMs:
        input.nextRunAtMs === null
          ? null
          : advanceInterval(input.nextRunAtMs, input.timing.everySeconds * 1000, input.nowMs),
      enabled: true,
      runStatus: "complete",
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
    nextRunAtMs:
      input.nextRunAtMs === null
        ? null
        : advanceInterval(
            input.nextRunAtMs,
            scheduleFailureDelayMs(input.timing.everySeconds, consecutiveFailures),
            input.nowMs,
          ),
    enabled: true,
    runStatus: "error",
  };
}
