import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  armTimeLimit,
  isStopReason,
  type MaxDuration,
  parseMaxDuration,
  stopReasonOf,
} from "../../src/loop/timeLimit";

function limit(seconds: number): MaxDuration {
  const parsed = parseMaxDuration(seconds);
  if (typeof parsed === "object") throw new Error(parsed.error);
  return parsed;
}

afterEach(() => {
  jest.useRealTimers();
});

describe("parseMaxDuration", () => {
  test.each(["1", "60", "2147483"])("argv %p parses to that many seconds", (raw) => {
    expect(parseMaxDuration(raw)).toBe(Number(raw));
  });

  test.each(["0", "abc", "1.5", "-1", "01", " 60", "1e3", "2147484", ""])(
    "argv %p is rejected",
    (raw) => {
      expect(parseMaxDuration(raw)).toEqual({
        error: "must be a whole number of seconds from 1 to 2147483",
      });
    },
  );

  test("a wire number in range parses", () => {
    expect(parseMaxDuration(900)).toBe(900);
  });

  test.each([0, 1.5, -1, 2147484, Number.NaN, Number.POSITIVE_INFINITY])(
    "wire %p is rejected",
    (raw) => {
      expect(typeof parseMaxDuration(raw)).toBe("object");
    },
  );
});

describe("armTimeLimit", () => {
  test("aborts the controller as timed-out at the limit and not before", () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    armTimeLimit(controller, limit(60));
    jest.advanceTimersByTime(59_999);
    expect(controller.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);
    expect(stopReasonOf(controller.signal)).toBe("timed-out");
  });

  test("disarm keeps a finished run from being aborted later", () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const disarm = armTimeLimit(controller, limit(60));
    disarm();
    jest.advanceTimersByTime(120_000);
    expect(controller.signal.aborted).toBe(false);
  });

  test("no limit never aborts", () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    armTimeLimit(controller, undefined);
    jest.advanceTimersByTime(2_147_483_000);
    expect(controller.signal.aborted).toBe(false);
  });

  test("a user cancel that lands first stays aborted when the limit passes", () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    armTimeLimit(controller, limit(60));
    controller.abort();
    jest.advanceTimersByTime(60_000);
    expect(stopReasonOf(controller.signal)).toBe("aborted");
  });

  test("a user cancel after the limit passed does not relabel the run", () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    armTimeLimit(controller, limit(60));
    jest.advanceTimersByTime(60_000);
    controller.abort();
    expect(stopReasonOf(controller.signal)).toBe("timed-out");
  });

  test("the cause survives a composed signal", () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const composed = AbortSignal.any([controller.signal]);
    armTimeLimit(controller, limit(60));
    jest.advanceTimersByTime(60_000);
    expect(stopReasonOf(composed)).toBe("timed-out");
  });
});

describe("stopReasonOf", () => {
  test("an abort with no reason or a foreign reason is a user cancel", () => {
    expect(stopReasonOf(AbortSignal.abort())).toBe("aborted");
    expect(stopReasonOf(AbortSignal.abort(new Error("time limit")))).toBe("aborted");
  });
});

describe("isStopReason", () => {
  test("names exactly the reasons a signal can cause", () => {
    expect(isStopReason("aborted")).toBe(true);
    expect(isStopReason("timed-out")).toBe(true);
    expect(isStopReason("max-iterations")).toBe(false);
    expect(isStopReason("no-tool-call")).toBe(false);
    expect(isStopReason(undefined)).toBe(false);
  });
});
