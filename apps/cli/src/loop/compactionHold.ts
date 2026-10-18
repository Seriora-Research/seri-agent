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
      readonly remainingTurns: number;
      readonly tokensAtArm: number;
    };

export const OPEN_COMPACTION_HOLD: CompactionHold = { status: "open" };

export function triggerTokens(usableInput: number, threshold: number): number {
  return usableInput * threshold;
}

export function watermarkTokens(trigger: number): number {
  return Math.floor(trigger * COMPACTION_WATERMARK_RATIO);
}

export function tickHold(
  hold: CompactionHold,
  windowTokens: number,
  usableInput: number,
): CompactionHold {
  if (hold.status !== "held") return hold;
  const growth = Math.floor(usableInput * COMPACTION_HOLD_GROWTH_RATIO);
  if (windowTokens - hold.tokensAtArm >= growth) return OPEN_COMPACTION_HOLD;
  if (hold.remainingTurns <= 0) return OPEN_COMPACTION_HOLD;
  return { ...hold, remainingTurns: hold.remainingTurns - 1 };
}

export function noteAutoCompactYield(args: {
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
      remainingTurns: COMPACTION_HOLD_TURNS,
      tokensAtArm: args.windowTokensAfter,
    },
    warn: COMPACTION_YIELD_LOW_MESSAGE,
  };
}
