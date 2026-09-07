// The TUI's frame and its vertical rhythm, beside theme.ts and read the same way.

import type { TranscriptKind, TranscriptRole } from "../util/format";
import { theme } from "./theme";

// Horizontal only, deliberately: PANEL_CHROME_ROWS (util/format.ts) budgets the rows a panel spends
// on chrome and every list window is sized against it, so a row of vertical padding would cost two
// rows per panel and shrink every list by that much.
export const PAD_X = 1;

// Surfaces that are not framed used to share this full-width rule as a floor join above the
// input box. The input FRAME already has a top rule, so App no longer paints this; the helper
// stays for anything that still needs a ─ mark of a given width.
export const HAIRLINE_CHAR = "─";

export function hairlineRow(columns: number): string {
  return HAIRLINE_CHAR.repeat(Math.max(0, columns));
}

// The frame for every bordered surface in the TUI, the input box included: one four-side box is
// the house style and there is no second family. `border` stays unset because BoxRenderable's own
// constructor (@opentui/core) promotes a box carrying `borderStyle`/`borderColor` to all four
// sides.
export const FRAME = {
  borderStyle: "single",
  borderColor: theme.border,
  paddingLeft: PAD_X,
  paddingRight: PAD_X,
} as const;

// A tool group's result line and its sub-lines sit under the group's own `→ name(arg)` call line,
// indented by this much (state/toolActivity.ts) so the group reads as one unit rather than as a
// stack of peers. Two columns, not PAD_X: this is indentation inside one text block, not the
// interior padding of a box, and tying it to PAD_X would make a change to the box inset silently
// reflow the transcript.
export const TOOL_INDENT = "  ";

// Blank rows between two adjacent transcript rows. A user turn still fences the exchange.
// File-change hunks and the tool-count line take a row of air so the harness events do not
// stack into one wall. Reasoning stays tight against the answer that follows it. One gap per
// adjacent pair — the table is consulted once, so a hunk then a summary is still a single
// blank row, not one from each kind.
const GAP_TABLE: Record<TranscriptRole, Record<TranscriptRole, 0 | 1>> = {
  user: { user: 1, assistant: 1, system: 1 },
  assistant: { user: 1, assistant: 0, system: 1 },
  system: { user: 1, assistant: 1, system: 0 },
};

// A transcript's first row has nothing to be separated from, so a session never opens on a blank
// row.
export function gapBefore(
  prev: TranscriptRole | undefined,
  cur: TranscriptRole,
  prevKind?: TranscriptKind,
  curKind?: TranscriptKind,
): 0 | 1 {
  if (prev === undefined) return 0;
  if (prevKind === "reasoning" && cur === "assistant") return 0;
  if (prev === "assistant" && curKind === "reasoning") return 0;
  if (prev === "user" || cur === "user") return GAP_TABLE[prev]?.[cur] ?? GAP_TABLE.user[cur];
  if (
    prevKind === "file-change" ||
    curKind === "file-change" ||
    prevKind === "tool-summary" ||
    curKind === "tool-summary"
  ) {
    return 1;
  }
  if (prev === "assistant" && cur === "system" && curKind !== "reasoning") return 1;
  if (prev === "system" && cur === "assistant") return 1;
  return GAP_TABLE[prev][cur];
}
