import { describe, expect, test } from "bun:test";
import {
  COMPACTION_HOLD_GROWTH_RATIO,
  COMPACTION_HOLD_TURNS,
  COMPACTION_YIELD_LOW_MESSAGE,
  type CompactionHold,
  holdClears,
  noteAutoCompactYield,
  OPEN_COMPACTION_HOLD,
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

describe("holdClears", () => {
  const held: CompactionHold = {
    status: "held",
    reason: "yield-low",
    armedAtIteration: 0,
    tokensAtArm: 4_500,
  };

  test("open never clears", () => {
    expect(holdClears(OPEN_COMPACTION_HOLD, 99, 9_000, usable)).toBe(false);
  });

  test("clears after N more iterations", () => {
    expect(holdClears(held, COMPACTION_HOLD_TURNS, 4_500, usable)).toBe(false);
    expect(holdClears(held, COMPACTION_HOLD_TURNS + 1, 4_500, usable)).toBe(true);
  });

  test("clears after the window grows by half of usable input", () => {
    const growth = Math.floor(usable * COMPACTION_HOLD_GROWTH_RATIO);
    expect(holdClears(held, 1, held.tokensAtArm + growth - 1, usable)).toBe(false);
    expect(holdClears(held, 1, held.tokensAtArm + growth, usable)).toBe(true);
  });
});

describe("noteAutoCompactYield", () => {
  test("opens when the window lands below the watermark", () => {
    expect(
      noteAutoCompactYield({
        iteration: 2,
        windowTokensAfter: watermark - 1,
        usableInput: usable,
        threshold,
      }),
    ).toEqual({ hold: OPEN_COMPACTION_HOLD, warn: undefined });
  });

  test("arms a hold and names the reason when the window stays at or above the watermark", () => {
    const noted = noteAutoCompactYield({
      iteration: 2,
      windowTokensAfter: watermark,
      usableInput: usable,
      threshold,
    });
    expect(noted.warn).toBe(COMPACTION_YIELD_LOW_MESSAGE);
    expect(noted.hold).toEqual({
      status: "held",
      reason: "yield-low",
      armedAtIteration: 2,
      tokensAtArm: watermark,
    });
  });
});
