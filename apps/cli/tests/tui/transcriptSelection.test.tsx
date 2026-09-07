/** @jsxImportSource @opentui/react */

import { afterEach, describe, expect, test } from "bun:test";
import { parseColor, type Renderable, type ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { TranscriptList } from "../../src/tui/components/TranscriptList";
import { MAIN_TUI_RENDERER_CONFIG } from "../../src/tui/runtime/renderOptions";
import { theme } from "../../src/tui/theme/theme";
import type { TranscriptEntry } from "../../src/tui/util/format";
import { flush, flushMarkdown, waitForSettledFrame } from "./helpers";

// Characterization of @opentui/core 0.5.6 selection/copy, rerunnable evidence for docs/specs/044-tui-selection-copy/research.md (issue #254).

const TERMINAL_WIDTH = 60;
const TERMINAL_HEIGHT = 20;

// createTestRenderer registers on the process-wide TerminalConsoleCache singleton; an undestroyed CliRenderer flakes later files in the same bun process.
const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

// flush() returns before stickyScroll has parked the tail; waitForSettledFrame waits until last.text is in the height-10 viewport and the capture stops changing.
async function mountTranscript(transcript: TranscriptEntry[]): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT });
  mountedRenderers.push(setup);
  createRoot(setup.renderer).render(
    <scrollbox height={10} stickyScroll stickyStart="bottom">
      <TranscriptList transcript={transcript} />
    </scrollbox>,
  );
  await flush(setup);
  const last = transcript.at(-1);
  if (last !== undefined) {
    // captureCharFrame can include last.text from an off-viewport paint while sticky-scroll is still moving, the macOS failure where the drag still used an older scrollTop.
    await waitForSettledFrame(setup, (frame) =>
      frame
        .split("\n")
        .slice(0, 10)
        .some((row) => row.includes(last.text)),
    );
  }
  return setup;
}

function copiedText(setup: TestRendererSetup): string {
  const selection = setup.renderer.getSelection();
  if (selection === null) throw new Error("the drag started no selection");
  return selection.getSelectedText();
}

// The scrollbox paints its scrollbar thumb in the last column, so transcript text is everything left of it.
function screenRow(frame: string, y: number): string {
  return (frame.split("\n")[y] ?? "").slice(0, TERMINAL_WIDTH - 1).trimEnd();
}

function scrollTopOf(setup: TestRendererSetup): number {
  const [scrollBox] = setup.renderer.root.getChildren();
  return (scrollBox as ScrollBoxRenderable).scrollTop;
}

function selectableTree(node: Renderable, depth = 0): string[] {
  return [
    `${"  ".repeat(depth)}${node.constructor.name} ${node.selectable}`,
    ...node.getChildren().flatMap((child) => selectableTree(child, depth + 1)),
  ];
}

const MIXED_TRANSCRIPT: TranscriptEntry[] = [
  { role: "user", text: "user asked about the parser" },
  { role: "assistant", text: "the `parse()` entry point handles it" },
  { role: "system", text: "tool ran read(src/parse.ts)" },
];

// role "system" so gapBefore does not insert blank rows; these tests measure screen-row-to-entry, not how many rows an entry occupies.
function denseRows(count: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    role: "system" as const,
    text: `entry ${index} text`,
  }));
}

// A renderer that has already resolved one drag reports a different result for the next, so each probed row gets its own mount.
async function probeScreenRow(
  transcript: TranscriptEntry[],
  y: number,
): Promise<{ scrollTop: number; shown: string; selected: string }> {
  const setup = await mountTranscript(transcript);
  try {
    await setup.renderOnce();
    const shown = screenRow(setup.captureCharFrame(), y);
    const scrollTop = scrollTopOf(setup);
    await setup.mockMouse.drag(0, y, 45, y);
    return { scrollTop, shown, selected: copiedText(setup) };
  } finally {
    mountedRenderers.splice(mountedRenderers.indexOf(setup), 1);
    setup.renderer.destroy();
  }
}

describe("transcript selection", () => {
  // OpenTUI's default enables ?1000/?1002/?1003/?1006, and a terminal reporting the mouse stops selecting text for the user (issue #254 strategy B, rejected).
  test("mouse reporting is off, which is what leaves the selection to the terminal", () => {
    expect(MAIN_TUI_RENDERER_CONFIG.useMouse).toBe(false);
  });

  test("selection comes from the leaf content, never from the scrollbox", async () => {
    const setup = await mountTranscript(MIXED_TRANSCRIPT);
    await flushMarkdown(setup, (frame) => frame.includes("entry point"));

    expect(selectableTree(setup.renderer.root)).toEqual([
      "RootRenderable false",
      "  ScrollBoxRenderable false",
      "    BoxRenderable false",
      "      TextRenderable true",
      "    BoxRenderable false",
      "      TextRenderable true",
      "      MarkdownRenderable false",
      "        CodeRenderable true",
      "    TextRenderable true",
    ]);
  });

  // OpenTUI derives the highlight from the row's own colours; seri passes no selectionBg/selectionFg.
  test("the highlight is reverse video of the row's own foreground", async () => {
    const setup = await mountTranscript(MIXED_TRANSCRIPT);
    await setup.mockMouse.pressDown(0, 0);
    await setup.mockMouse.moveTo(20, 0);
    await setup.renderOnce();

    const [selected] = setup.captureSpans().lines[0]?.spans ?? [];
    if (selected === undefined) throw new Error("the drag painted no span");
    expect(selected.text).toBe("user asked about the");
    const rowFg = parseColor(theme.text);
    expect(selected.bg.r).toBeCloseTo(rowFg.r, 5);
    expect(selected.bg.g).toBeCloseTo(rowFg.g, 5);
    expect(selected.bg.b).toBeCloseTo(rowFg.b, 5);
    expect([selected.fg.r, selected.fg.g, selected.fg.b]).toEqual([0, 0, 0]);

    await setup.mockMouse.release(20, 0);
  });

  test("a drag across the whole unscrolled transcript copies every row in order", async () => {
    const setup = await mountTranscript(MIXED_TRANSCRIPT);
    await flushMarkdown(setup, (frame) => frame.includes("entry point"));
    await setup.mockMouse.drag(0, 0, 45, 3);

    const lines = copiedText(setup).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("user asked about the parser");
    expect(lines[1]).toContain("the parse() entry point handles it");
    expect(lines[2]).toBe("tool ran read(src/parse.ts)");
  });

  test("each row is selectable on its own, with no opt-in flag", async () => {
    const user = await mountTranscript(MIXED_TRANSCRIPT);
    await user.mockMouse.drag(0, 0, 45, 0);
    expect(copiedText(user)).toBe("user asked about the parser");

    // Column 2, not 0: columns 0–1 are the assistant bullet gutter, unselectable in the test below.
    const assistant = await mountTranscript(MIXED_TRANSCRIPT);
    await flushMarkdown(assistant, (frame) => frame.includes("entry point"));
    await assistant.mockMouse.drag(2, 2, 45, 2);
    expect(copiedText(assistant)).toBe("the parse() entry point handles it");

    const tool = await mountTranscript(MIXED_TRANSCRIPT);
    await tool.mockMouse.drag(0, 3, 45, 3);
    expect(copiedText(tool)).toBe("tool ran read(src/parse.ts)");
  });

  test("defect: the ● marker leaks into the copied assistant text", async () => {
    const setup = await mountTranscript(MIXED_TRANSCRIPT);
    await flushMarkdown(setup, (frame) => frame.includes("entry point"));
    await setup.mockMouse.drag(0, 0, 45, 3);

    expect(copiedText(setup)).toContain("●the parse() entry point handles it");
  });

  test("defect: a drag started on the assistant row's bullet gutter starts no selection", async () => {
    const setup = await mountTranscript(MIXED_TRANSCRIPT);
    await flushMarkdown(setup, (frame) => frame.includes("entry point"));
    await setup.mockMouse.drag(0, 2, 45, 2);

    expect(setup.renderer.hasSelection).toBe(false);
    expect(setup.renderer.getSelection()).toBeNull();
  });

  test("defect: copied markdown is the rendered text, not the source", async () => {
    const setup = await mountTranscript(MIXED_TRANSCRIPT);
    await flushMarkdown(setup, (frame) => frame.includes("entry point"));
    await setup.mockMouse.drag(0, 0, 45, 3);

    const copied = copiedText(setup);
    expect(copied).toContain("parse()");
    expect(copied).not.toContain("`");
  });

  test("an unscrolled transcript selects the entry shown at each screen row", async () => {
    for (let y = 0; y <= 4; y++) {
      const { scrollTop, shown, selected } = await probeScreenRow(denseRows(5), y);
      expect(scrollTop).toBe(0);
      expect(shown).toBe(`entry ${y} text`);
      expect(selected).toBe(shown);
    }
  });

  test("a transcript parked at its tail selects the entry shown at screen rows 3 to 9", async () => {
    for (let y = 3; y <= 9; y++) {
      const { scrollTop, shown, selected } = await probeScreenRow(denseRows(24), y);
      expect(scrollTop).toBe(14);
      expect(shown).toBe(`entry ${14 + y} text`);
      expect(selected).toBe(shown);
    }
  });

  // After stickyStart=bottom parks at scrollTop 14, rows 0–2 resolve against geometry that no longer matches the paint.
  test("defect: a scrolled transcript resolves its top three screen rows to the wrong entry", async () => {
    const first = await probeScreenRow(denseRows(24), 0);
    expect(first.scrollTop).toBe(14);
    expect(first.shown).toBe("entry 14 text");
    expect(first.selected).not.toBe(first.shown);

    const second = await probeScreenRow(denseRows(24), 1);
    expect(second.scrollTop).toBe(14);
    expect(second.shown).toBe("entry 15 text");
    expect(second.selected).not.toBe(second.shown);

    const third = await probeScreenRow(denseRows(24), 2);
    expect(third.scrollTop).toBe(14);
    expect(third.shown).toBe("entry 16 text");
    expect(third.selected).not.toBe(third.shown);
  });
});
