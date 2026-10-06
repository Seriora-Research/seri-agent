import { describe, expect, test } from "bun:test";
import { cadenceAfterFire } from "../../src/session/scheduleCadence";

const interval = { kind: "interval" as const, everySeconds: 60 };

describe("cadenceAfterFire", () => {
  test("an interval success resets the failure count and keeps the original delay", () => {
    expect(
      cadenceAfterFire({
        timing: interval,
        consecutiveFailures: 2,
        nextRunAtMs: 100_000,
        failed: false,
        error: null,
        nowMs: 100_000,
      }),
    ).toEqual({
      consecutiveFailures: 0,
      pauseReason: null,
      nextRunAtMs: 160_000,
      enabled: true,
      runStatus: "complete",
    });
  });

  test("the first interval failure keeps the original delay", () => {
    expect(
      cadenceAfterFire({
        timing: interval,
        consecutiveFailures: 0,
        nextRunAtMs: 100_000,
        failed: true,
        error: "401 unauthorized",
        nowMs: 100_000,
      }),
    ).toEqual({
      consecutiveFailures: 1,
      pauseReason: null,
      nextRunAtMs: 160_000,
      enabled: true,
      runStatus: "error",
    });
  });

  test("the second consecutive interval failure doubles the delay", () => {
    expect(
      cadenceAfterFire({
        timing: interval,
        consecutiveFailures: 1,
        nextRunAtMs: 160_000,
        failed: true,
        error: "401 unauthorized",
        nowMs: 160_000,
      }),
    ).toEqual({
      consecutiveFailures: 2,
      pauseReason: null,
      nextRunAtMs: 280_000,
      enabled: true,
      runStatus: "error",
    });
  });

  test("the third consecutive interval failure pauses with the error as the reason", () => {
    expect(
      cadenceAfterFire({
        timing: interval,
        consecutiveFailures: 2,
        nextRunAtMs: 280_000,
        failed: true,
        error: "401 unauthorized",
        nowMs: 280_000,
      }),
    ).toEqual({
      consecutiveFailures: 3,
      pauseReason: "401 unauthorized",
      nextRunAtMs: null,
      enabled: false,
      runStatus: "paused",
    });
  });

  test("a once schedule still consumes the firing instead of auto-pausing", () => {
    expect(
      cadenceAfterFire({
        timing: { kind: "once", at: "1970-01-01T00:00:00.000Z" },
        consecutiveFailures: 0,
        nextRunAtMs: 0,
        failed: true,
        error: "401 unauthorized",
        nowMs: 0,
      }),
    ).toEqual({
      consecutiveFailures: 1,
      pauseReason: null,
      nextRunAtMs: null,
      enabled: false,
      runStatus: "error",
    });
  });
});
