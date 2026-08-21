// InputBox.tsx throttles its own repaints during a rapid keystroke burst (a held Backspace,
// which repeats at up to ~30 keystrokes/second) so the terminal isn't asked to redraw on every
// one of them, while never delaying a normally-paced keystroke and never submitting a stale
// pre-flush value on Enter. Mirrors InputBox's own `THROTTLE_MS` rather than importing it: the
// constant is deliberately not exported (InputBox.tsx's own comment — not meant to be
// configurable), so these tests assert against the same real-world number a reader of that file
// sees, not a shared symbol.
import { describe, expect, spyOn, test } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { InputBox } from "../../src/tui/panels/InputBox";
import { flush } from "./helpers";

const THROTTLE_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("InputBox throttled repaints", () => {
  // `stdin.write()` -> `EventEmitter.emit('data', ...)` runs the `useInput` handler (and
  // therefore `scheduleUpdate`) synchronously, in the same call stack as the write — a burst of
  // writes with no `await` between them arrives, from `scheduleUpdate`'s point of view, far
  // faster than `THROTTLE_MS` apart, the same way OS key-repeat delivers real backspaces faster
  // than React (or a test) can render a frame per keystroke. Asserting on Ink's own rendered
  // frame count across that burst doesn't isolate this component's throttle from React 18+'s
  // OWN automatic batching of synchronous state updates (measured directly against this harness:
  // batching alone already collapses the burst to ~1 commit, with or without InputBox's
  // throttle, so frame count can't tell the two apart here). `setTimeout` is the mechanism
  // `scheduleUpdate` itself uses to coalesce, and nothing else runs synchronously inside that
  // burst (the `useInput`-driven state update settles on a later microtask, same finding
  // inkInputSpike.test.tsx documents, so it can't schedule anything inside this synchronous
  // loop) — spying on it directly is what isolates "does InputBox schedule one flush for the
  // whole burst, or one per keystroke" from React's own unrelated batching.
  test("a rapid backspace burst schedules at most one pending flush timer, not one per keystroke", async () => {
    const instance = render(createElement(InputBox));
    await flush();

    instance.stdin.write("x".repeat(30));
    await flush();
    await sleep(THROTTLE_MS + 20); // let the leading edge from typing cool down before the burst

    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    const callsBefore = setTimeoutSpy.mock.calls.length;

    const n = 15;
    for (let i = 0; i < n; i++) {
      instance.stdin.write("\x7f");
    }
    const scheduled = setTimeoutSpy.mock.calls.length - callsBefore;
    setTimeoutSpy.mockRestore();

    expect(scheduled).toBeLessThanOrEqual(1);

    await sleep(THROTTLE_MS + 30); // let the coalesced flush land
    expect(instance.lastFrame()).toContain("x".repeat(30 - n));

    instance.unmount();
  });

  test("keystrokes spaced beyond the throttle window each get their own immediate render", async () => {
    const instance = render(createElement(InputBox));
    await flush();

    const framesBefore = instance.frames.length;
    const n = 5;
    const gapMs = 150; // slower than THROTTLE_MS: a deliberate typing pace, never coalesced
    for (let i = 0; i < n; i++) {
      instance.stdin.write(String.fromCharCode(97 + i));
      await sleep(gapMs);
    }

    const framesAfter = instance.frames.length - framesBefore;
    expect(framesAfter).toBe(n);

    instance.unmount();
  });

  test("rapid backspaces immediately followed by Enter submit the fully-updated value, not a stale pre-flush snapshot", async () => {
    const submitted: string[] = [];
    const instance = render(
      createElement(InputBox, { onSubmit: (v: string) => submitted.push(v) }),
    );
    await flush();

    instance.stdin.write("hello world");
    await flush();
    await sleep(THROTTLE_MS + 20); // cool the leading edge from typing before the burst

    // The first backspace consumes the leading edge and flushes immediately; the remaining four
    // queue behind ONE pending timer. Enter arrives in the same synchronous burst, well before
    // that timer could ever fire.
    for (let i = 0; i < 5; i++) {
      instance.stdin.write("\x7f");
    }
    instance.stdin.write("\r");
    await flush();

    expect(submitted).toEqual(["hello "]);

    instance.unmount();
  });

  test("a keystroke right after submit gets its own immediate render, not a throttle delay left over from before Enter", async () => {
    const submitted: string[] = [];
    const instance = render(
      createElement(InputBox, { onSubmit: (v: string) => submitted.push(v) }),
    );
    await flush();

    // All three writes land in the same synchronous burst — no real time elapses between the
    // leading-edge flush of "hi" and the "y" typed right after Enter, the same way a fast human
    // submit-then-type does. Only one `flush()` at the end: if "y" is stuck behind a scheduled
    // timer left over from a stale `lastFlushRef`, this single settled macrotask (far short of
    // THROTTLE_MS) isn't enough time for that timer to fire.
    instance.stdin.write("hi"); // leading-edge flush, since it's the first keystroke this mount
    instance.stdin.write("\r"); // Enter, submits "hi" and clears the input
    instance.stdin.write("y"); // typed immediately after submit
    await flush();

    expect(submitted).toEqual(["hi"]);
    expect(instance.lastFrame()).toContain("y");

    instance.unmount();
  });
});
