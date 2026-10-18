export const COMPACTION_WATERMARK_RATIO = 0.8;
export const COMPACTION_HOLD_TURNS = 10;
export const COMPACTION_HOLD_GROWTH_RATIO = 0.5;

export const COMPACTION_YIELD_LOW_MESSAGE =
  "compaction did not free enough context (yield stayed above the watermark); auto-compaction paused";

export type CompactionHold =
  | { readonly status: "open" }
  | {
      readonly status: "held";
      readonly reason: "yield-low";
      readonly armedAtIteration: number;
      readonly tokensAtArm: number;
    };

export const OPEN_COMPACTION_HOLD: CompactionHold = { status: "open" };

export function triggerTokens(usableInput: number, threshold: number): number {
  return usableInput * threshold;
}

export function watermarkTokens(trigger: number): number {
  return Math.floor(trigger * COMPACTION_WATERMARK_RATIO);
}

export function holdClears(
  hold: CompactionHold,
  iteration: number,
  windowTokens: number,
  usableInput: number,
): boolean {
  if (hold.status !== "held") return false;
  if (iteration - hold.armedAtIteration > COMPACTION_HOLD_TURNS) return true;
  const growth = Math.floor(usableInput * COMPACTION_HOLD_GROWTH_RATIO);
  return windowTokens - hold.tokensAtArm >= growth;
}

export function noteAutoCompactYield(args: {
  iteration: number;
  windowTokensAfter: number;
  usableInput: number;
  threshold: number;
}):
  | { hold: typeof OPEN_COMPACTION_HOLD; warn: undefined }
  | { hold: Extract<CompactionHold, { status: "held" }>; warn: string } {
  const watermark = watermarkTokens(triggerTokens(args.usableInput, args.threshold));
  if (args.windowTokensAfter < watermark) {
    return { hold: OPEN_COMPACTION_HOLD, warn: undefined };
  }
  return {
    hold: {
      status: "held",
      reason: "yield-low",
      armedAtIteration: args.iteration,
      tokensAtArm: args.windowTokensAfter,
    },
    warn: COMPACTION_YIELD_LOW_MESSAGE,
  };
}
