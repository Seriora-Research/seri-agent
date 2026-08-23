/** @jsxImportSource @opentui/react */
// InputBox.tsx throttles its own repaints during a rapid keystroke burst (a held Backspace,
// which repeats at up to ~30 keystrokes/second) so the terminal isn't asked to redraw on every
// one of them, while never delaying a normally-paced keystroke and never submitting a stale
// pre-flush value on Enter. inputBox.test.tsx already covers the burst-coalescing and
// submit-uses-latest-value halves of that contract; this file keeps only the two scenarios it
// doesn't cover, to avoid asserting the same behavior twice: that a normally-paced keystroke is
// never throttled at all (no timer scheduled), and that a keystroke typed right after a submit
// gets its own immediate flush rather than inheriting a stale `lastFlushRef` from before Enter.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";

import { InputBox } from "../../src/tui/components/InputBox";

const THROTTLE_MS = 50;

// Every `createTestRenderer` call registers its own listener on the process-wide
// `TerminalConsoleCache` singleton (App.test.tsx's own comment on this, verbatim) — undestroyed
// across this file's own tests, the same real cross-file flakiness inkInputSpike.test.tsx's own
// comment documents.
const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// @opentui/react's reconciler commits on a macrotask, not a microtask (mirrors inputBox.test.tsx's
// own `settle` helper and its comment): `useKeyboard`/`usePaste` subscribe from a plain (passive)
// `useEffect`, which needs a SECOND settled render pass after mount before the subscription
// actually exists.
async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  createRoot(setup.renderer).render(node);
  await settle(setup); // commits the mount
  await settle(setup); // lets passive effects (useKeyboard/usePaste's useEffect) subscribe
  // A third pass, unlike inputBox.test.tsx's/modelPicker.test.tsx's own identical two-pass
  // `mount()`: this file's own `afterEach` now destroys the PREVIOUS test's renderer right before
  // the next `createTestRenderer()` call (this file's own comment on that), and under CPU
  // contention the second test's own keyboard subscription sometimes still hadn't landed after
  // just two passes (confirmed live: CI-only, all four burst-fired keypresses silently dropped).
  // A harmless no-op once already settled.
  await settle(setup);
}

describe("InputBox throttled repaints", () => {
  // `mockInput.pressKey()` emits synchronously (`renderer.stdin.emit("data", ...)`, same
  // technique inputBox.test.tsx's own burst test relies on), so a `setTimeout` spy wrapped tightly
  // around a single keypress isolates exactly what that one keystroke scheduled.
  test("keystrokes spaced beyond the throttle window each flush immediately, without ever scheduling a pending timer", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    await mount(setup, <InputBox />);

    const gapMs = THROTTLE_MS + 50; // slower than THROTTLE_MS: a deliberate typing pace, never coalesced
    const chars = "abcde";
    for (const ch of chars) {
      const setTimeoutSpy = spyOn(globalThis, "setTimeout");
      setup.mockInput.pressKey(ch);
      const scheduled = setTimeoutSpy.mock.calls.length;
      setTimeoutSpy.mockRestore();

      expect(scheduled).toBe(0);
      await settle(setup);
      await sleep(gapMs);
    }

    expect(setup.captureCharFrame()).toContain(`> ${chars}`);
  });

  test("a keystroke right after submit gets its own immediate flush, not a throttle delay left over from before Enter", async () => {
    const submitted: string[] = [];
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    await mount(setup, <InputBox onSubmit={(v) => submitted.push(v)} />);

    // All four land in the same synchronous burst -- no real time elapses between the leading-edge
    // flush of "h" and the "y" typed right after Enter, the same way a fast human submit-then-type
    // does.
    setup.mockInput.pressKey("h");
    setup.mockInput.pressKey("i");
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey("y");
    await settle(setup);

    expect(submitted).toEqual(["hi"]);
    expect(setup.captureCharFrame()).toContain("> y");
  });
});
