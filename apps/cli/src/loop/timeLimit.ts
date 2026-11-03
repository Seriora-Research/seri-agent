declare const maxDurationBrand: unique symbol;
export type MaxDuration = number & { readonly [maxDurationBrand]: true };

// Bun clamps a setTimeout past 2^31 - 1 ms to 1 ms, which would end the run at once.
const MAX_DURATION_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

const STOP_REASONS = ["aborted", "timed-out"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

class TimeLimitReached extends Error {
  constructor(limit: MaxDuration) {
    super(`the run reached its ${limit}-second time limit`);
    this.name = "TimeLimitReached";
  }
}

function isMaxDuration(seconds: number): seconds is MaxDuration {
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= MAX_DURATION_SECONDS;
}

export function parseMaxDuration(raw: string | number): MaxDuration | { error: string } {
  const seconds = typeof raw === "number" ? raw : /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (isMaxDuration(seconds)) return seconds;
  return { error: `must be a whole number of seconds from 1 to ${MAX_DURATION_SECONDS}` };
}

/** The returned disarm must run when the run ends: a pending timer holds the process open until it fires. */
export function armTimeLimit(
  controller: AbortController,
  limit: MaxDuration | undefined,
): () => void {
  if (limit === undefined) return () => {};
  const timer = setTimeout(() => controller.abort(new TimeLimitReached(limit)), limit * 1000);
  return () => clearTimeout(timer);
}

export function stopReasonOf(signal: AbortSignal | undefined): StopReason {
  return signal?.reason instanceof TimeLimitReached ? "timed-out" : "aborted";
}

export function isStopReason(reason: string | undefined): reason is StopReason {
  return reason !== undefined && (STOP_REASONS as readonly string[]).includes(reason);
}
