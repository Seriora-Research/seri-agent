import { describe, expect, test } from "bun:test";
import {
  COMPACTION_HOLD_GROWTH_RATIO,
  COMPACTION_HOLD_TURNS,
  COMPACTION_YIELD_LOW_MESSAGE,
  type CompactionHold,
  noteAutoCompactYield,
  OPEN_COMPACTION_HOLD,
  tickHold,
  triggerTokens,
  watermarkTokens,
} from "../../src/loop/compactionHold";

const usable = 10_000;
const threshold = 0.5;
const trigger = triggerTokens(usable, threshold);
const watermark = watermarkTokens(trigger);

describe("watermarkTokens", () => {
  test("is 80% of the trigger, floored", () => {
    expect(trigger).toBe(5_000);
    expect(watermark).toBe(4_000);
  });
});

describe("tickHold", () => {
  const held = (remainingTurns: number): Extract<CompactionHold, { status: "held" }> => ({
    status: "held",
    reason: "yield-low",
    remainingTurns,
    tokensAtArm: 4_500,
  });

  test("open never ticks", () => {
    expect(tickHold(OPEN_COMPACTION_HOLD, 9_000, usable)).toEqual(OPEN_COMPACTION_HOLD);
  });

  test("stays held for N later turns, then opens", () => {
    let hold: CompactionHold = held(COMPACTION_HOLD_TURNS);
    for (let i = 0; i < COMPACTION_HOLD_TURNS; i++) {
      hold = tickHold(hold, 4_500, usable);
      expect(hold.status).toBe("held");
    }
    expect(tickHold(hold, 4_500, usable)).toEqual(OPEN_COMPACTION_HOLD);
  });

  test("opens after the window grows by half of usable input", () => {
    const growth = Math.floor(usable * COMPACTION_HOLD_GROWTH_RATIO);
    const hold = held(COMPACTION_HOLD_TURNS);
    const stillOver = hold.tokensAtArm + growth - 1;
    const grown = hold.tokensAtArm + growth;
    expect(tickHold(hold, stillOver, usable)).toEqual({
      ...hold,
      remainingTurns: COMPACTION_HOLD_TURNS - 1,
    });
    expect(tickHold(hold, grown, usable)).toEqual(OPEN_COMPACTION_HOLD);
  });
});

describe("noteAutoCompactYield", () => {
  test("opens when the window lands below the watermark", () => {
    expect(
      noteAutoCompactYield({
        windowTokensAfter: watermark - 1,
        usableInput: usable,
        threshold,
      }),
    ).toEqual({ hold: OPEN_COMPACTION_HOLD, warn: undefined });
  });

  test("arms a hold and names the reason when the window stays at or above the watermark", () => {
    const noted = noteAutoCompactYield({
      windowTokensAfter: watermark,
      usableInput: usable,
      threshold,
    });
    expect(noted.warn).toBe(COMPACTION_YIELD_LOW_MESSAGE);
    expect(noted.hold).toEqual({
      status: "held",
      reason: "yield-low",
      remainingTurns: COMPACTION_HOLD_TURNS,
      tokensAtArm: watermark,
    });
  });
});
