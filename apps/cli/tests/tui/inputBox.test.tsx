/** @jsxImportSource @opentui/react */
// InputBox.tsx (apps/cli/src/tui/components/InputBox.tsx), the OpenTUI port of the old
// panels/InputBox.tsx. Resolves the one thing Phase 1's spike left open for the hand-rolled
// fallback specifically (docs/specs/025-tui-opentui-migration/tasks.md): does the rapid-backspace
// throttle (THROTTLE_MS/pendingValueRef, ported from PR #135) still do real work on this renderer,
// or was it an Ink-only artifact? Mirrors tests/tui/inputThrottle.test.tsx's own
// spy-on-setTimeout technique (that file's own comment explains why: frame/render count alone
// can't isolate this component's own throttle from React 18's automatic batching of synchronous
// state updates).
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { describe, expect, spyOn, test } from "bun:test";
import type { ReactNode } from "react";
import { InputBox } from "../../src/tui/components/InputBox";

const THROTTLE_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// @opentui/react's reconciler commits on a macrotask, not a microtask (Phase 1's own finding):
// `useKeyboard`/`usePaste` subscribe from a plain (passive) `useEffect`, which needs a SECOND
// settled render pass after mount before the subscription actually exists — a single settle()
// after mount produced zero recorded keypresses when this was first verified against this
// harness.
async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  createRoot(setup.renderer).render(node);
  await settle(setup); // commits the mount
  await settle(setup); // lets passive effects (useKeyboard/usePaste's useEffect) subscribe
}

describe("InputBox (OpenTUI)", () => {
  test("typed text renders with the '> ' prefix", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox />);

    await setup.mockInput.typeText("hello");
    await settle(setup);
    await sleep(THROTTLE_MS + 20); // only the leading-edge character flushes immediately

    expect(setup.captureCharFrame()).toContain("> hello");
  });

  test("a rapid backspace burst schedules at most one pending flush timer, not one per keystroke", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox />);

    await setup.mockInput.typeText("x".repeat(30));
    await settle(setup);
    await sleep(THROTTLE_MS + 20); // let the leading edge from typing cool down before the burst

    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    const callsBefore = setTimeoutSpy.mock.calls.length;

    const n = 15;
    for (let i = 0; i < n; i++) {
      setup.mockInput.pressBackspace();
    }
    const scheduled = setTimeoutSpy.mock.calls.length - callsBefore;
    setTimeoutSpy.mockRestore();

    // Verified this bound is not a vacuous pass: temporarily forcing every `scheduleUpdate` call to
    // also schedule its own timer ahead of the `timerRef.current !== null` guard (simulating that
    // guard being dropped/forgotten — the realistic regression this assertion exists to catch)
    // makes `scheduled` come back 16 (one per backspace, plus the leading-edge timer from typing),
    // failing this assertion. A separate, unthrottled measurement (calling `setValue` directly
    // instead of going through `scheduleUpdate` at all) found OpenTUI's own native frame scheduler
    // already coalesces a synchronous 15-keystroke burst down to ~1-2 real terminal paints
    // regardless — so unlike Ink (where this throttle capped real terminal writes), on OpenTUI it
    // caps REACT-level re-render/state-churn count instead. Smaller win than under Ink, but a real
    // and free one: kept.
    expect(scheduled).toBeLessThanOrEqual(1);

    await sleep(THROTTLE_MS + 30); // let the coalesced flush land
    expect(setup.captureCharFrame()).toContain("x".repeat(30 - n));
  });

  test("rapid backspaces immediately followed by Enter submit the fully-updated value, not a stale pre-flush snapshot", async () => {
    const submitted: string[] = [];
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox onSubmit={(v) => submitted.push(v)} />);

    await setup.mockInput.typeText("hello world");
    await settle(setup);
    await sleep(THROTTLE_MS + 20);

    for (let i = 0; i < 5; i++) {
      setup.mockInput.pressBackspace();
    }
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(submitted).toEqual(["hello "]);
  });

  test("usePaste's terminator-splitting submits before the terminator and keeps what's after", async () => {
    const submitted: string[] = [];
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox onSubmit={(v) => submitted.push(v)} />);

    await setup.mockInput.pasteBracketedText("first line\r\nsecond line");
    await settle(setup);

    expect(submitted).toEqual(["first line"]);
    expect(setup.captureCharFrame()).toContain("> second line");
  });

  test("an arrow key is inert, not inserted as raw escape bytes", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox />);

    await setup.mockInput.typeText("ab");
    await settle(setup);
    await sleep(THROTTLE_MS + 20); // only the leading-edge character flushes immediately
    setup.mockInput.pressArrow("up");
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("> ab");
    expect(setup.captureCharFrame()).not.toContain("[A");
  });
});
