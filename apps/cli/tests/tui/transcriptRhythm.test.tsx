/** @jsxImportSource @opentui/react */
// spacing.test.ts proves GAP_TABLE's values and reducer.test.ts proves nothing fake is pushed into
// the transcript to produce a blank row. Neither proves the margin reaches the screen. This does,
// by rendering TranscriptList and counting the rows between entries in the frame.

import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";

import { TranscriptList } from "../../src/tui/components/TranscriptList";
import { theme } from "../../src/tui/theme/theme";
import type { TranscriptEntry } from "../../src/tui/util/format";

// See inputBox.test.tsx: each createTestRenderer registers its own listener on the process-wide
// TerminalConsoleCache singleton, and leaking those across files makes order-dependent flakiness.
const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

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

// The frame is padded to the renderer's full height, so trailing blanks are the empty screen below
// the content, not rhythm. Only rows between the first and last painted row count.
function paintedRows(setup: TestRendererSetup): string[] {
  const rows = setup
    .captureCharFrame()
    .split("\n")
    .map((row) => row.trimEnd());
  const first = rows.findIndex((row) => row.length > 0);
  let last = rows.length - 1;
  while (last >= 0 && rows[last]?.length === 0) last--;
  return first === -1 ? [] : rows.slice(first, last + 1);
}

async function render(transcript: TranscriptEntry[]): Promise<string[]> {
  const setup = await createTestRenderer({ width: 60, height: 14 });
  await mount(setup, <TranscriptList transcript={transcript} />);
  return paintedRows(setup);
}

// An assistant row shows as a bare "●" here: `<markdown>` parses on the tree-sitter client, which
// has not resolved by the time this harness captures. The bullet is painted by the row itself, so
// it still pins where the row landed, which is all these tests read.
describe("transcript vertical rhythm", () => {
  test("a user turn is fenced by a blank row on each side", async () => {
    const rows = await render([
      { role: "system", text: "Session created.", muted: true },
      { role: "user", text: "> hello" },
      { role: "system", text: "Read biome.json", muted: true },
      { role: "assistant", text: "done" },
    ]);

    expect(rows).toEqual(["Session created.", "", "> hello", "", "Read biome.json", "", "●"]);
  });

  test("the first entry never opens the transcript on a blank row", async () => {
    const rows = await render([{ role: "user", text: "> hello" }]);

    expect(rows).toEqual(["> hello"]);
  });

  test("a second user turn is separated from the reply before it", async () => {
    const rows = await render([
      { role: "user", text: "> one" },
      { role: "assistant", text: "first" },
      { role: "user", text: "> two" },
    ]);

    expect(rows).toEqual(["> one", "", "●", "", "> two"]);
  });

  test("user then reasoning is one blank row, reasoning then assistant is tight", async () => {
    const rows = await render([
      { role: "user", text: "> check the spec" },
      {
        role: "system",
        text: "▸ thought · 4s",
        muted: true,
        kind: "reasoning",
        body: "start at ROADMAP",
        elapsedMs: 4_000,
      },
      { role: "assistant", text: "I'll look at the roadmap" },
    ]);

    expect(rows[0]).toBe("> check the spec");
    expect(rows[1]).toBe("");
    expect(rows[2]).toContain("▸ thought · 4s");
    expect(rows[2]).not.toContain("●");
    expect(rows[2]).not.toContain("→");
    expect(rows[3]).toBe("●");
    expect(rows).not.toContain("start at ROADMAP");
  });

  test("an open reasoning body is muted indented text, not markdown", async () => {
    const rows = await render([
      {
        role: "system",
        text: "▾ thought · 4s",
        muted: true,
        kind: "reasoning",
        body: "a *literal* star",
        expanded: true,
        elapsedMs: 4_000,
      },
    ]);

    const joined = rows.join("\n");
    expect(joined).toContain("▾ thought · 4s");
    expect(joined).toContain("a *literal* star");
    expect(joined).not.toContain("●");
  });

  test("a file-change block paints the title, hunks, and overflow on their own rows", async () => {
    const rows = await render([
      { role: "user", text: "> edit it" },
      {
        role: "system",
        text: "Write a.ts  +1 −1\n- old\n+ new\n… 3 more",
        kind: "file-change",
        fileChange: {
          kind: "update",
          title: "Write a.ts",
          added: 1,
          removed: 1,
          hidden: 3,
          lines: [
            { kind: "del", text: "- old" },
            { kind: "add", text: "+ new" },
          ],
        },
      },
    ]);

    expect(rows).toEqual(["> edit it", "", "Write a.ts  +1 −1", " - old", " + new", "… 3 more"]);
  });

  test("add lines paint diffAdd and del lines paint diffDel", async () => {
    const setup = await createTestRenderer({ width: 60, height: 14 });
    await mount(
      setup,
      <TranscriptList
        transcript={[
          {
            role: "system",
            text: "Write a.ts  +1 −1\n- old\n+ new",
            kind: "file-change",
            fileChange: {
              kind: "update",
              title: "Write a.ts",
              added: 1,
              removed: 1,
              hidden: 0,
              lines: [
                { kind: "del", text: "- old" },
                { kind: "add", text: "+ new" },
              ],
            },
          },
        ]}
      />,
    );
    const spans = setup.captureSpans();
    const addSpan = spans.lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes("+ new"));
    const delSpan = spans.lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes("- old"));
    expect(addSpan, "no span found containing + new").toBeDefined();
    expect(delSpan, "no span found containing - old").toBeDefined();
    expect(addSpan?.fg.equals(parseColor(theme.diffAdd))).toBe(true);
    expect(delSpan?.fg.equals(parseColor(theme.diffDel))).toBe(true);
    const addBar = spans.lines
      .flatMap((line) => line.spans)
      .find((span) => span.bg.equals(parseColor(theme.diffAdd)));
    const delBar = spans.lines
      .flatMap((line) => line.spans)
      .find((span) => span.bg.equals(parseColor(theme.diffDel)));
    expect(addBar, "no add gutter bar").toBeDefined();
    expect(delBar, "no del gutter bar").toBeDefined();
  });

  test("a long hunk line truncates on one row instead of wrapping", async () => {
    const long = `+ ${"x".repeat(80)}`;
    const setup = await createTestRenderer({ width: 40, height: 10 });
    await mount(
      setup,
      <TranscriptList
        transcript={[
          {
            role: "system",
            text: long,
            kind: "file-change",
            fileChange: {
              kind: "update",
              title: "Edit",
              added: 1,
              removed: 0,
              hidden: 0,
              lines: [{ kind: "add", text: long }],
            },
          },
        ]}
      />,
    );
    const rows = paintedRows(setup);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Edit");
    expect(rows[1]?.includes("+ ")).toBe(true);
    expect(rows[1]?.length).toBeLessThanOrEqual(40);
    expect(rows.some((row) => row.includes("xx") && !row.includes("+"))).toBe(false);
  });

  test("two file-change blocks are separated by a blank row", async () => {
    const hunk = (title: string): TranscriptEntry => ({
      role: "system",
      text: `${title}  +1 −0`,
      kind: "file-change",
      fileChange: {
        kind: "update",
        title,
        added: 1,
        removed: 0,
        hidden: 0,
        lines: [{ kind: "add", text: "+ x" }],
      },
    });
    const rows = await render([hunk("Edit"), hunk("Write b.ts")]);
    expect(rows).toEqual(["Edit  +1 −0", " + x", "", "Write b.ts  +1 −0", " + x"]);
  });

  test("turn +/- stats paint add green and del red", async () => {
    const setup = await createTestRenderer({ width: 60, height: 8 });
    await mount(
      setup,
      <TranscriptList
        transcript={[
          {
            role: "system",
            text: "+4 −1",
            kind: "file-change-stats",
            fileChangeStats: { added: 4, removed: 1 },
          },
        ]}
      />,
    );
    const spans = setup.captureSpans();
    const addSpan = spans.lines.flatMap((line) => line.spans).find((span) => span.text.includes("+4"));
    const delSpan = spans.lines.flatMap((line) => line.spans).find((span) => span.text.includes("−1"));
    expect(addSpan?.fg.equals(parseColor(theme.diffAdd))).toBe(true);
    expect(delSpan?.fg.equals(parseColor(theme.diffDel))).toBe(true);
  });
});
