/** @jsxImportSource @opentui/react */

import { afterEach, describe, expect, test } from "bun:test";
import type { Renderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { TranscriptList } from "../../src/tui/components/TranscriptList";
import type { TranscriptEntry } from "../../src/tui/util/format";
import { flush, flushMarkdown } from "./helpers";

// Characterization of what @opentui/core 0.5.6 lets a reader select and copy out of seri's real
// transcript, and the rerunnable evidence behind docs/specs/044-tui-selection-copy/research.md
// (issue #254). Three of these tests pin defects rather than desired behavior; each says so in its
// own name and names the correct behavior above it, so a fix upstream or in seri fails this file
// and sends someone back to the spec.

const TERMINAL_WIDTH = 60;
const TERMINAL_HEIGHT = 20;

// See App.test.tsx's own copy of this: every `createTestRenderer` builds a real `CliRenderer`,
// which registers a listener on the process-wide `TerminalConsoleCache` singleton, and this repo hit
// a real listener leak without a teardown that destroys them.
const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

// The scrollbox props mirror the real one the transcript sits in (app.tsx) — `stickyScroll` and
// `stickyStart="bottom"` are what park a long transcript at its tail, which is the geometry the
// scrolled-selection tests below depend on. Mounted without the surrounding <App> deliberately: the
// scrollbox plus the real TranscriptList is the whole surface selection reaches.
async function mountTranscript(transcript: TranscriptEntry[]): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT });
  mountedRenderers.push(setup);
  createRoot(setup.renderer).render(
    <scrollbox height={10} stickyScroll stickyStart="bottom">
      <TranscriptList transcript={transcript} />
    </scrollbox>,
  );
  await flush(setup);
  return setup;
}

function copiedText(setup: TestRendererSetup): string {
  const selection = setup.renderer.getSelection();
  if (selection === null) throw new Error("the drag started no selection");
  return selection.getSelectedText();
}

// The scrollbox paints its scrollbar thumb in the frame's last column, so a captured row's
// transcript text is everything left of it.
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

function userRows(count: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    role: "user" as const,
    text: `entry ${index} text`,
  }));
}

// A renderer that has already resolved one drag reports a different result for the next one, so
// every probed screen row gets its own mount, and each is destroyed as soon as it has been read
// rather than piling ten live renderers up behind `afterEach`.
async function probeScreenRow(
  transcript: TranscriptEntry[],
  y: number,
): Promise<{ scrollTop: number; shown: string; selected: string }> {
  const setup = await mountTranscript(transcript);
  try {
    const shown = screenRow(setup.captureCharFrame(), y);
    await setup.mockMouse.drag(0, y, 45, y);
    return { scrollTop: scrollTopOf(setup), shown, selected: copiedText(setup) };
  } finally {
    mountedRenderers.splice(mountedRenderers.indexOf(setup), 1);
    setup.renderer.destroy();
  }
}

describe("transcript selection", () => {
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

  test("a drag across the whole unscrolled transcript copies every row in order", async () => {
    const setup = await mountTranscript(MIXED_TRANSCRIPT);
    await flushMarkdown(setup, (frame) => frame.includes("entry point"));
    await setup.mockMouse.drag(0, 0, 45, 2);

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

    // Column 2, not 0: columns 0-1 are the assistant row's bullet gutter, which the test below
    // pins as unselectable.
    const assistant = await mountTranscript(MIXED_TRANSCRIPT);
    await flushMarkdown(assistant, (frame) => frame.includes("entry point"));
    await assistant.mockMouse.drag(2, 1, 45, 1);
    expect(copiedText(assistant)).toBe("the parse() entry point handles it");

    const tool = await mountTranscript(MIXED_TRANSCRIPT);
    await tool.mockMouse.drag(0, 2, 45, 2);
    expect(copiedText(tool)).toBe("tool ran read(src/parse.ts)");
  });

  // Correct behavior: the copy is the assistant's own words. `●` is TranscriptRow's absolutely-
  // positioned marker (components/TranscriptList.tsx) — chrome, not content — and it lands in the
  // copy glued to the first word with no separating space.
  test("defect: the ● marker leaks into the copied assistant text", async () => {
    const setup = await mountTranscript(MIXED_TRANSCRIPT);
    await flushMarkdown(setup, (frame) => frame.includes("entry point"));
    await setup.mockMouse.drag(0, 0, 45, 2);

    expect(copiedText(setup)).toContain("●the parse() entry point handles it");
  });

  // Correct behavior: a drag anywhere along the assistant row selects that row. The bullet is an
  // overlay outside the flex flow, so the hit target across the gutter it paints into is the
  // MarkdownRenderable that reserves those columns as padding — and that is not selectable, so a
  // drag begun there starts nothing at all rather than selecting the row it was aimed at.
  test("defect: a drag started on the assistant row's bullet gutter starts no selection", async () => {
    const setup = await mountTranscript(MIXED_TRANSCRIPT);
    await flushMarkdown(setup, (frame) => frame.includes("entry point"));
    await setup.mockMouse.drag(0, 1, 45, 1);

    expect(setup.renderer.hasSelection).toBe(false);
    expect(setup.renderer.getSelection()).toBeNull();
  });

  // Correct behavior: copying a model answer hands back the markdown the model wrote, backticks and
  // all, so it can be pasted somewhere that renders it. The copy is what MarkdownRenderable painted
  // instead, so the inline code span's own markers are gone and `parse()` comes back as bare prose.
  test("defect: copied markdown is the rendered text, not the source", async () => {
    const setup = await mountTranscript(MIXED_TRANSCRIPT);
    await flushMarkdown(setup, (frame) => frame.includes("entry point"));
    await setup.mockMouse.drag(0, 0, 45, 2);

    const copied = copiedText(setup);
    expect(copied).toContain("parse()");
    expect(copied).not.toContain("`");
  });

  test("an unscrolled transcript selects the entry shown at each screen row", async () => {
    for (let y = 0; y <= 4; y++) {
      const { scrollTop, shown, selected } = await probeScreenRow(userRows(5), y);
      expect(scrollTop).toBe(0);
      expect(shown).toBe(`entry ${y} text`);
      expect(selected).toBe(shown);
    }
  });

  test("a transcript parked at its tail selects the entry shown at screen rows 3 to 9", async () => {
    for (let y = 3; y <= 9; y++) {
      const { scrollTop, shown, selected } = await probeScreenRow(userRows(24), y);
      expect(scrollTop).toBe(14);
      expect(shown).toBe(`entry ${14 + y} text`);
      expect(selected).toBe(shown);
    }
  });

  // Correct behavior: these three screen rows resolve to the entry printed on them, the way rows 3
  // to 9 above already do. Once `stickyStart="bottom"` has parked the transcript at its tail
  // (scrollTop 14, entries 14-23 filling rows 0-9), the top of the viewport resolves against
  // geometry that no longer matches what is painted: rows 0 and 1 hand back the entry ABOVE the one
  // on screen, and row 2 hands back nothing.
  test("defect: a scrolled transcript resolves its top three screen rows to the wrong entry", async () => {
    const first = await probeScreenRow(userRows(24), 0);
    expect(first.shown).toBe("entry 14 text");
    expect(first.selected).toBe("entry 13 text");

    const second = await probeScreenRow(userRows(24), 1);
    expect(second.shown).toBe("entry 15 text");
    expect(second.selected).toBe("entry 14 text");

    const third = await probeScreenRow(userRows(24), 2);
    expect(third.shown).toBe("entry 16 text");
    expect(third.selected).toBe("");
  });
});
