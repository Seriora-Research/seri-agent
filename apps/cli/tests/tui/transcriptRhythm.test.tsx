/** @jsxImportSource @opentui/react */
// spacing.test.ts proves GAP_TABLE's values and reducer.test.ts proves nothing fake is pushed into
// the transcript to produce a blank row. Neither proves the margin reaches the screen. This does,
// by rendering TranscriptList and counting the rows between entries in the frame.

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";

import { TranscriptList } from "../../src/tui/components/TranscriptList";
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
  test("a user turn is fenced by a blank row on each side, and the turn under it runs together", async () => {
    const rows = await render([
      { role: "system", text: "Session created.", muted: true },
      { role: "user", text: "> hello" },
      { role: "system", text: "Read biome.json", muted: true },
      { role: "assistant", text: "done" },
    ]);

    expect(rows).toEqual(["Session created.", "", "> hello", "", "Read biome.json", "●"]);
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
});
