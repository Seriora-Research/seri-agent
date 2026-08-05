import { describe, expect, test } from "bun:test";
import { onAbort } from "../src/abort";

describe("onAbort", () => {
  // Both directions in one test because the point is the contrast: a bare addEventListener answers
  // the second half and silently misses the first, so either half on its own fails to discriminate.
  // The first half is the one with no other coverage in this repo — spawnCollect's and runRipgrep's
  // cancel tests both abort after the child is spawned, and they skip on Windows besides, so this
  // is the only place the already-aborted rule is checked on every platform. It is not a
  // theoretical case: loop.ts checks the signal, then yields a tool-call event, and the consumer's
  // signal handler runs in exactly that suspension, so execute really is entered with a signal that
  // has already fired.
  test("invokes the handler for a signal that is already aborted, not only for one that aborts later", () => {
    const already: string[] = [];
    const past = onAbort(AbortSignal.abort(), () => already.push("cancelled"));

    // Synchronously at registration, not queued: the caller goes straight on to await work that
    // will never be cancelled again, so a handler deferred to a later turn arrives after that work
    // has already run to completion — which is the whole failure being prevented.
    expect(already).toEqual(["cancelled"]);
    expect(past.aborted()).toBe(true);
    // Safe on this path too. The listener is registered before it is invoked, so there is one for
    // dispose to remove, and callers clean up identically whichever way the cancel arrived.
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
