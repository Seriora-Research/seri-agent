import { describe, expect, test } from "bun:test";
import { onAbort } from "../src/abort";

describe("onAbort", () => {








  test("invokes the handler for a signal that is already aborted, not only for one that aborts later", () => {
    const already: string[] = [];
    const past = onAbort(AbortSignal.abort(), () => already.push("cancelled"));




    expect(already).toEqual(["cancelled"]);
    expect(past.aborted()).toBe(true);


    expect(() => past.dispose()).not.toThrow();

    const controller = new AbortController();
    const later: string[] = [];
    const pending = onAbort(controller.signal, () => later.push("cancelled"));

    expect(later).toEqual([]);
    expect(pending.aborted()).toBe(false);
    controller.abort();
    expect(later).toEqual(["cancelled"]);
    expect(pending.aborted()).toBe(true);
    pending.dispose();
  });
});
