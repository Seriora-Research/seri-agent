import { describe, expect, test } from "bun:test";
import { cadenceAfterFire, consumeSlot } from "../../src/session/scheduleCadence";

const interval = { kind: "interval" as const, everySeconds: 60 };

describe("consumeSlot", () => {
  test("a once schedule disables", () => {
    expect(consumeSlot({ kind: "once", at: "1970-01-01T00:00:00.000Z" }, 0, 5_000)).toEqual({
      enabled: false,
      nextRunAtMs: null,
    });
  });

  test("an interval moves to the first slot on its grid after now", () => {
    expect(consumeSlot(interval, 100_000, 100_000)).toEqual({
      enabled: true,
      nextRunAtMs: 160_000,
    });
    expect(consumeSlot(interval, 100_000, 250_000)).toEqual({
      enabled: true,
      nextRunAtMs: 280_000,
    });
  });

  test("an interval still leaves a slot when now is earlier than that slot", () => {
    expect(consumeSlot(interval, 100_000, 90_000)).toEqual({
      enabled: true,
      nextRunAtMs: 160_000,
    });
  });
});

describe("cadenceAfterFire", () => {
  test("an interval success resets the failure count and keeps the original delay", () => {
    expect(
      cadenceAfterFire({
        timing: interval,
        consecutiveFailures: 2,
        slotMs: 100_000,
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
        slotMs: 100_000,
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
        slotMs: 160_000,
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
        slotMs: 280_000,
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

  test("an interval success still leaves the slot when now is earlier than that slot", () => {
    expect(
      cadenceAfterFire({
        timing: interval,
        consecutiveFailures: 0,
        slotMs: 100_000,
        failed: false,
        error: null,
        nowMs: 90_000,
      }),
    ).toMatchObject({
      nextRunAtMs: 160_000,
      enabled: true,
      runStatus: "complete",
    });
  });

  test("the first interval failure still leaves the slot when now is earlier than that slot", () => {
    expect(
      cadenceAfterFire({
        timing: interval,
        consecutiveFailures: 0,
        slotMs: 100_000,
        failed: true,
        error: "401 unauthorized",
        nowMs: 90_000,
      }),
    ).toMatchObject({
      nextRunAtMs: 160_000,
      enabled: true,
      runStatus: "error",
    });
  });

  test("a once schedule still consumes the firing instead of auto-pausing", () => {
    expect(
      cadenceAfterFire({
        timing: { kind: "once", at: "1970-01-01T00:00:00.000Z" },
        consecutiveFailures: 0,
        slotMs: 0,
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
