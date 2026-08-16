// Extracted out of App.tsx (Stage A, cli-commands-to-tui feature-plan.md) verbatim: a pure move,
// no behavior change. Imports its constants/formatters from ../format.

import type { ModelProvider } from "@seri/model-catalog";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ModelPickerEntry } from "../commands";
import { formatModelRow, MODEL_PICKER_HEADER, matchesFilter, remaining } from "../format";
import { theme } from "../theme";
import { useListWindow } from "../useListWindow";

// /model's own live state (tui/reducer.ts's pendingModelPicker) — mirrors ApprovalBox's shape
// exactly: its own useInput, a round-bordered box, mutually exclusive with InputBox. `filterQuery`
// and `selectedIndex` are local component state, not reducer state, for the same reason InputBox's
// own `value` is: this is transient UI data with no reason to survive a resolve/cancel or be
// visible to anything outside this component.
export function ModelPicker({
  entries,
  onModelSelected,
  onModelPickerCancel,
}: {
  entries: ModelPickerEntry[];
  onModelSelected?: (
    pick: { model: string; provider: ModelProvider },
    leftoverInput?: string,
  ) => void;
  onModelPickerCancel?: () => void;
}) {
  const [filterQuery, setFilterQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  // C1 fix: the window rendered used to always be `filtered.slice(0, windowSize)` — the first N
  // entries, regardless of `selectedIndex` — so Down past the visible window moved the highlight
  // somewhere nothing on screen showed, and with 279 catalog entries most of the list was
  // unreachable. `scrollOffset` is the top of the currently-rendered window, from useListWindow —
  // it only moves when `selectedIndex` would otherwise land outside it (`onSelectionMove`), not
  // recomputed fresh from `selectedIndex` on every render, which would re-center the window on
  // every keypress instead of sliding it only when actually needed.
  const {
    offset: scrollOffset,
    windowSize,
    onSelectionMove,
    reset: resetScroll,
  } = useListWindow(selectedIndex);

  const filtered =
    filterQuery.length === 0 ? entries : entries.filter((row) => matchesFilter(row, filterQuery));

  // Moves the selection to `next` (already clamped to `[0, filtered.length - 1]` by the caller).
  function moveSelection(next: number): void {
    setSelectedIndex(next);
    onSelectionMove(next);
  }

  useInput((input, key) => {
    // Escape OR Ctrl-D — deliberately NOT ApprovalBox's Ctrl-D (which triggers app quit): this is
    // "never mind, back to typing", not a graceful-quit sequence.
    if (key.escape || (key.ctrl && input === "d")) {
      onModelPickerCancel?.();
      return;
    }
    if (key.upArrow) {
      moveSelection(Math.max(0, selectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      moveSelection(Math.min(filtered.length - 1, selectedIndex + 1));
      return;
    }
    if (key.return) {
      const row = filtered[selectedIndex];
      if (row !== undefined) {
        onModelSelected?.({ model: row.entry.id, provider: row.entry.provider });
      }
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.backspace || key.delete) {
      setFilterQuery((query) => query.slice(0, -1));
      setSelectedIndex(0);
      resetScroll();
      return;
    }
    if (input.length === 0) return;
    // MEDIUM-E's own finding (InputBox, above), applying here too: a chunk delivered faster than
    // one keypress per `useInput` call — typed filter text immediately followed by Enter, measured
    // on a real pty to arrive as ONE combined chunk rather than two separate calls — can embed a
    // `\r`/`\n` that `key.return` above never sees, since that only fires for a chunk that IS a
    // bare terminator on its own. Everything up to the first terminator is filter text; the
    // terminator itself selects the top match against the FULLY updated query, mirroring
    // `key.return`'s own action (against `selectedIndex 0`, the same reset every other
    // filter-changing keystroke already applies) rather than silently dropping the keystroke.
    const terminatorIndex = input.search(/[\r\n]/);
    const typed = terminatorIndex === -1 ? input : input.slice(0, terminatorIndex);
    const nextQuery = filterQuery + typed;
    if (terminatorIndex === -1) {
      setFilterQuery(nextQuery);
      setSelectedIndex(0);
      resetScroll();
      return;
    }
    // Code-review finding: this used to stop at `typed` and silently discard everything after the
    // terminator — real keystrokes vanished with no trace once the picker closed. `terminatorLength`
    // mirrors InputBox's own MEDIUM-4 fix (a `\r\n` pair, the common Windows-clipboard shape, is ONE
    // terminator, not two) and `after` is handed to `onModelSelected` so it can prefill the very next
    // InputBox mount — the closest equivalent here to InputBox's own "awaiting its own Enter" carry.
    const terminatorLength = input.startsWith("\r\n", terminatorIndex) ? 2 : 1;
    const after = input.slice(terminatorIndex + terminatorLength);
    const nextFiltered =
      nextQuery.length === 0 ? entries : entries.filter((row) => matchesFilter(row, nextQuery));
    const row = nextFiltered[0];
    if (row !== undefined) {
      onModelSelected?.({ model: row.entry.id, provider: row.entry.provider }, after || undefined);
    }
  });

  const visible = filtered.slice(scrollOffset, scrollOffset + windowSize);
  const remainingCount = remaining(filtered.length, scrollOffset, windowSize);

  return (
    <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
      <Text>{filterQuery.length > 0 ? filterQuery : " "}</Text>
      {/* Same reasoning as the row Text below: MODEL_PICKER_HEADER's own fixed column widths sum to
      the same ~87 chars, so it soft-wraps on the identical narrow terminals the row fix guards
      against. */}
      <Text color={theme.muted} wrap="truncate-end">{`  ${MODEL_PICKER_HEADER}`}</Text>
      {visible.map((row, localIndex) => {
        const index = scrollOffset + localIndex;
        return (
          // `wrap="truncate-end"` (found by review, same reasoning as ConfigPanel's own row Text):
          // formatModelRow's fixed column widths sum to ~87 chars — real on any terminal narrower
          // than that, not a hypothetical edge case — and PANEL_CHROME_ROWS (format.ts) budgets
          // exactly one row per list row regardless.
          <Text
            key={`${row.entry.provider}/${row.entry.id}`}
            color={index === selectedIndex ? theme.accent : undefined}
            wrap="truncate-end"
          >
            {index === selectedIndex ? "> " : "  "}
            {formatModelRow(row)}
          </Text>
        );
      })}
      {remainingCount > 0 && (
        <Text color={theme.muted}>+{remainingCount} more — keep typing to narrow</Text>
      )}
    </Box>
  );
}
