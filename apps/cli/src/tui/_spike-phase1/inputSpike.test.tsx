/** @jsxImportSource @opentui/react */
// THROWAWAY SPIKE test — Phase 1 of docs/specs/025-tui-opentui-migration/tasks.md. Automated,
// programmatic evidence for the InputBox half of the Phase 1 gate: drives both the native <input>
// and the hand-rolled useKeyboard/usePaste fallback through the same real backspace-burst and
// paste-terminator scenarios InputBox.tsx (apps/cli/src/tui/panels/InputBox.tsx) is built for.
// Deleted along with the rest of _spike-phase1/ before Phase 2's real InputBox rewrite starts.
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { HandRolledInputSpike, NativeInputSpike } from "./inputSpike";

// @opentui/react's reconciler commit needs a real macrotask yield before a renderOnce()/mockInput
// call reliably observes it (see transcriptSpike.test.tsx's own comment on this same helper).
// `useKeyboard`/`usePaste` subscribe from a plain `useEffect` (confirmed by direct read of
// @opentui/react's compiled index.js), which is a PASSIVE effect — it does not run in the same
// commit as the one that mounts the component, so mockInput calls need to wait for a SECOND
// settled render pass after mount before the keyHandler subscription actually exists, or the
// first burst of input is silently dropped. Empirically confirmed against this harness: a single
// settle() after mount produced zero recorded keypresses here.
async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  createRoot(setup.renderer).render(node);
  await settle(setup); // commits the mount
  await settle(setup); // lets passive effects (useKeyboard/usePaste's useEffect) subscribe
}

describe("Phase 1 spike: does OpenTUI's native <input> fit InputBox's semantics?", () => {
  test("native <input> ends up correct after a rapid backspace burst, with zero throttle code in NativeInputSpike", async () => {
    const values: string[] = [];
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <NativeInputSpike onValueChange={(v) => values.push(v)} />);

    await setup.mockInput.typeText("hello world");
    await settle(setup);

    // 5 backspaces fired with NO delay between them — the same burst inputThrottle.test.tsx (Ink's
    // InputBox) drives against Ink's own useInput. This is the scenario InputBox.tsx's own
    // THROTTLE_MS/pendingValueRef machinery exists to coalesce. NativeInputSpike has none of that
    // code at all: the native <input> owns and repaints its own buffer internally, so there is
    // nothing here for a React-level throttle to protect against.
    for (let i = 0; i < 5; i++) {
      setup.mockInput.pressBackspace();
    }
    await settle(setup);

    expect(values[values.length - 1]).toBe("hello ");
  });

  test("native <input> strips embedded \\r/\\n from a pasted chunk instead of splitting it into multiple submits", async () => {
    const submitted: string[] = [];
    const values: string[] = [];
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(
      setup,
      <NativeInputSpike
        onValueChange={(v) => values.push(v)}
        onSubmit={(v) => submitted.push(v)}
      />,
    );

    // A pasted stack trace / multi-line snippet — the exact case InputBox.tsx's own MEDIUM-E
    // comment names ("a pasted stack trace is the real case"), with a Windows-clipboard-style
    // \r\n pair as the second terminator (InputBox.tsx's own MEDIUM-4 case).
    await setup.mockInput.pasteBracketedText("first line\r\nsecond line");
    await settle(setup);

    // No submit happened at all — the native <input>'s own handlePaste strips `\n`/`\r` and
    // inserts what's left as ONE edit, rather than treating the embedded terminator as an Enter.
    // This is the opposite of InputBox.tsx's own terminator-splitting behavior (which would submit
    // "first line" and leave "second line" as the new pending value).
    expect(submitted).toEqual([]);
    expect(values[values.length - 1]).toBe("first linesecond line");
  });
});

describe("Phase 1 spike: the hand-rolled useKeyboard/usePaste fallback (if native <input> doesn't fit)", () => {
  test("a rapid backspace burst ends up correct without Ink's useInput at all", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <HandRolledInputSpike />);

    await setup.mockInput.typeText("hello world");
    await settle(setup);

    for (let i = 0; i < 5; i++) {
      setup.mockInput.pressBackspace();
    }
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("> hello ");
  });

  test("usePaste's terminator-splitting mirrors InputBox.tsx's own behavior: submits before the terminator, keeps what's after", async () => {
    const submitted: string[] = [];
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <HandRolledInputSpike onSubmit={(v) => submitted.push(v)} />);

    await setup.mockInput.pasteBracketedText("first line\r\nsecond line");
    await settle(setup);

    expect(submitted).toEqual(["first line"]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("> second line");
  });
});
