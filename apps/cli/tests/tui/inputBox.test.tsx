/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";

import { InputBox, inputCaretLayout } from "../../src/tui/components/InputBox";
import { theme } from "../../src/tui/theme/theme";
import { DEFAULT_COLUMNS, INPUT_PLACEHOLDER } from "../../src/tui/util/format";

const THROTTLE_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// createTestRenderer registers on the process-wide TerminalConsoleCache singleton; an undestroyed CliRenderer flakes later files in the same bun process.
const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

// @opentui/react commits on a macrotask; useKeyboard/usePaste subscribe on the second settled pass.
async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  mountedRenderers.push(setup);
  createRoot(setup.renderer).render(node);
  await settle(setup);
  await settle(setup);
}

describe("InputBox (OpenTUI)", () => {
  test("typed text renders with the '> ' prefix", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox onSubmit={() => {}} />);

    await setup.mockInput.typeText("hello");
    await settle(setup);
    await sleep(THROTTLE_MS + 20); // only the leading-edge character flushes immediately
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("> hello");
  });

  test("a rapid backspace burst schedules at most one pending flush timer, not one per keystroke", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox onSubmit={() => {}} />);

    await setup.mockInput.typeText("x".repeat(30));
    await settle(setup);
    await sleep(THROTTLE_MS + 20);

    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    const callsBefore = setTimeoutSpy.mock.calls.length;

    const n = 15;
    for (let i = 0; i < n; i++) {
      setup.mockInput.pressBackspace();
    }
    const scheduled = setTimeoutSpy.mock.calls.length - callsBefore;
    setTimeoutSpy.mockRestore();

    // OpenTUI's native scheduler already coalesces the burst to ~1–2 paints, so this spies setTimeout rather than frames.
    expect(scheduled).toBeLessThanOrEqual(1);

    await sleep(THROTTLE_MS + 30);
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

  test("arrowing past the sixth completion row scrolls the window to matches below it", async () => {
    const items = Array.from({ length: 26 }, (_, i) => ({
      value: `/cmd${i}`,
      description: `does thing ${i}`,
    }));
    const setup = await createTestRenderer({ width: 60, height: 14 });
    await mount(
      setup,
      <InputBox
        onSubmit={() => {}}
        completionSources={[{ id: "test", trigger: "/", lineStartOnly: true, items }]}
      />,
    );

    await setup.mockInput.typeText("/");
    await settle(setup);
    await sleep(THROTTLE_MS + 20);

    expect(setup.captureCharFrame()).toContain("/cmd0");
    expect(setup.captureCharFrame()).not.toContain("/cmd8");

    for (let i = 0; i < 8; i++) {
      setup.mockInput.pressArrow("down");
    }
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("/cmd8");
    expect(frame).not.toContain("/cmd0");
  });

  test("an arrow key is inert, not inserted as raw escape bytes", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox onSubmit={() => {}} />);

    await setup.mockInput.typeText("ab");
    await settle(setup);
    await sleep(THROTTLE_MS + 20); // only the leading-edge character flushes immediately
    setup.mockInput.pressArrow("up");
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("> ab");
    expect(setup.captureCharFrame()).not.toContain("[A");
  });

  test("inert empty Down still fires onEmptyDown", async () => {
    const downs: number[] = [];
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox inert onSubmit={() => {}} onEmptyDown={() => downs.push(1)} />);

    setup.mockInput.pressArrow("down");
    await settle(setup);

    expect(downs).toEqual([1]);
  });

  test("inert printable key does not change the value", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox inert onSubmit={() => {}} />);

    await setup.mockInput.typeText("x");
    await settle(setup);
    await sleep(THROTTLE_MS + 20);

    expect(setup.captureCharFrame()).toContain("> ");
    expect(setup.captureCharFrame()).not.toContain("> x");
  });

  test("Escape with the completion popup open dismisses the popup and does not call onEscape", async () => {
    const escapes: number[] = [];
    const setup = await createTestRenderer({ width: 40, height: 12 });
    await mount(
      setup,
      <InputBox
        onSubmit={() => {}}
        onEscape={() => escapes.push(1)}
        completionSources={[
          {
            id: "test",
            trigger: "/",
            lineStartOnly: true,
            items: [{ value: "/model", description: "switch model" }],
          },
        ]}
      />,
    );

    await setup.mockInput.typeText("/");
    await settle(setup);
    await sleep(THROTTLE_MS + 20);
    expect(setup.captureCharFrame()).toContain("/model");

    setup.mockInput.pressEscape();
    await sleep(30);
    await settle(setup);
    await sleep(THROTTLE_MS + 20);

    expect(escapes).toEqual([]);
    expect(setup.captureCharFrame()).not.toContain("/model");
  });

  test("Escape with no popup open calls onEscape once", async () => {
    const escapes: number[] = [];
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox onSubmit={() => {}} onEscape={() => escapes.push(1)} />);

    setup.mockInput.pressEscape();
    // OpenTUI holds a bare ESC for a disambiguation window longer than settle's macrotask tick.
    await sleep(30);
    await settle(setup);

    expect(escapes).toEqual([1]);
  });

  test("Escape is inert while the box is, so a mid-edit row keeps the keypress", async () => {
    const escapes: number[] = [];
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox inert onSubmit={() => {}} onEscape={() => escapes.push(1)} />);

    setup.mockInput.pressEscape();
    await sleep(30);
    await settle(setup);

    expect(escapes).toEqual([]);
  });

  test("bare renders the value with no border and no marker", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox bare prefill="already typed" onSubmit={() => {}} />);
    await settle(setup);
    await sleep(THROTTLE_MS + 20);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("already typed");
    expect(frame).not.toContain("> already typed");
    expect(frame).not.toContain("▁");
  });

  test("the default form still renders the marker", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    await mount(setup, <InputBox prefill="already typed" onSubmit={() => {}} />);
    await settle(setup);
    await sleep(THROTTLE_MS + 20);

    expect(setup.captureCharFrame()).toContain("> already typed");
  });

  // DEFAULT_COLUMNS, not 40 or 60: truncate clips INPUT_PLACEHOLDER on a 60-column box.
  test("the placeholder renders on an empty input and is gone after one character", async () => {
    const setup = await createTestRenderer({ width: DEFAULT_COLUMNS, height: 5 });
    await mount(setup, <InputBox onSubmit={() => {}} />);

    expect(setup.captureCharFrame()).toContain(INPUT_PLACEHOLDER);

    await setup.mockInput.typeText("h");
    await settle(setup);
    await sleep(THROTTLE_MS + 20);

    expect(setup.captureCharFrame()).toContain("> h");
    expect(setup.captureCharFrame()).not.toContain(INPUT_PLACEHOLDER);
  });

  test("the block cursor sits on the last wrapped row, not the first", async () => {
    const setup = await createTestRenderer({ width: 24, height: 8 });
    await mount(
      setup,
      <InputBox prefill={`${"word ".repeat(12)}end`} onSubmit={() => {}} />,
    );
    await settle(setup);
    await sleep(THROTTLE_MS + 20);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("> word");
    expect(frame).toContain("end");

    const lines = setup.captureSpans().lines;
    const cursorLine = lines.findIndex((line) =>
      line.spans.some((span) => span.bg.equals(parseColor(theme.accent))),
    );
    const firstTextLine = lines.findIndex((line) =>
      line.spans.some((span) => span.text.includes(">")),
    );
    expect(firstTextLine).toBeGreaterThanOrEqual(0);
    expect(cursorLine).toBeGreaterThan(firstTextLine);
    const cursorSpans = lines[cursorLine]?.spans ?? [];
    expect(cursorSpans.some((span) => span.text.includes("end") || span.text === " ")).toBe(true);
  });
});

describe("inputCaretLayout", () => {
  test("an empty value is a caret on the first row", () => {
    expect(inputCaretLayout("", 10)).toEqual({ above: [], last: "" });
  });

  test("text shorter than the width stays on one row with the caret", () => {
    expect(inputCaretLayout("> hello", 20)).toEqual({ above: [], last: "> hello" });
  });

  test("text longer than the width leaves the caret on the last chunk", () => {
    expect(inputCaretLayout("abcdefghij", 4)).toEqual({
      above: ["abcd", "efgh"],
      last: "ij",
    });
  });

  test("an exact multiple of the width drops the caret to a new row", () => {
    expect(inputCaretLayout("abcdefgh", 4)).toEqual({
      above: ["abcd", "efgh"],
      last: "",
    });
  });
});
