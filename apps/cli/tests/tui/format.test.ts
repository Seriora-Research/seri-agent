import { describe, expect, test } from "bun:test";
import {
  estimateTokens,
  formatElapsed,
  formatTokenProgress,
  type TokenProgress,
} from "../../src/tui/util/format";

describe("formatElapsed", () => {
  test("under a minute renders as seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
  });

  test("under an hour renders as minutes and seconds", () => {
    expect(formatElapsed(65_000)).toBe("1m 5s");
  });

  test("an hour or more renders as hours and minutes, dropping seconds", () => {
    expect(formatElapsed(3_700_000)).toBe("1h 1m");
  });
});

describe("estimateTokens", () => {
  // fx's own test strategy: a chunk-boundary-dependent estimate would flicker as a real stream's
  // SSE framing happens to land differently between two otherwise-identical runs. Splitting a
  // fixed string at every possible index (including mid-word) and asserting the two halves'
  // estimates always sum to the whole's estimate is what proves that can't happen — this fails
  // immediately against a per-chunk-`Math.ceil`ing implementation (see estimateTokens's own
  // comment on why it defers rounding to display time instead).
  const fixed = "The quick brown fox jumps over the lazy dog. Résumé naïve café — emdash, "; // includes multi-byte chars

  test("splitting the string at every index sums to the same total as estimating it whole", () => {
    const whole = estimateTokens(fixed);
    for (let i = 0; i <= fixed.length; i++) {
      const sum = estimateTokens(fixed.slice(0, i)) + estimateTokens(fixed.slice(i));
      expect(sum).toBeCloseTo(whole, 10);
    }
  });
});

describe("formatTokenProgress", () => {
  function progress(overrides: Partial<TokenProgress> = {}): TokenProgress {
    return {
      reconciledInputTokens: 10,
      reconciledOutputTokens: 20,
      liveOutputEstimate: 0,
      inputExact: true,
      outputExact: true,
      ...overrides,
    };
  }

  test("omits ~ when both input and output are exact", () => {
    expect(formatTokenProgress(progress())).toBe("10 in, 20 out");
  });

  test("prefixes both with ~ when input is still an estimate", () => {
    expect(formatTokenProgress(progress({ inputExact: false }))).toBe("~10 in, ~20 out");
  });

  test("prefixes both with ~ when output is still an estimate", () => {
    expect(formatTokenProgress(progress({ outputExact: false }))).toBe("~10 in, ~20 out");
  });

  test("adds the live output estimate on top of the reconciled total", () => {
    expect(formatTokenProgress(progress({ outputExact: false, liveOutputEstimate: 5 }))).toBe(
      "~10 in, ~25 out",
    );
  });
});
