// Extracted out of App.tsx (Stage A, cli-commands-to-tui feature-plan.md) verbatim: a pure move,
// no behavior change. Imports its constants/formatters from ../format.

import type { ModelProvider } from "@seri/model-catalog";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ModelPickerEntry } from "../commands";
import { ListRow } from "../components";
import { formatModelRow, MODEL_PICKER_HEADER, matchesFilter } from "../format";
import { theme } from "../theme";
import { useListWindow } from "../useListWindow";

// /model's own live state (tui/reducer.ts's pendingModelPicker) — mirrors ApprovalBox's shape
// exactly: its own useInput, a single-bordered box, mutually exclusive with InputBox. `filterQuery`
// is local component state, not reducer state, for the same reason InputBox's own `value` is: this
// is transient UI data with no reason to survive a resolve/cancel or be visible to anything outside
// this component. The selection index is owned by useListWindow instead, for the same reason.
export function ModelPicker({
  entries,
  onModelSelected,
  onModelPickerCancel,
}: {
  entries: ModelPickerEntry[];
  onModelSelected?: (
    pick: { model: string; provider: ModelProvider; keyConfigured: boolean },
    leftoverInput?: string,
  ) => void;
  onModelPickerCancel?: () => void;
}) {
  const [filterQuery, setFilterQuery] = useState("");

  const filtered =
    filterQuery.length === 0 ? entries : entries.filter((row) => matchesFilter(row, filterQuery));

  // Fixes a prior bug where the window rendered always started at `filtered.slice(0, windowSize)`
  // — the first N entries, regardless of the selection — so Down past the visible window moved
  // the highlight somewhere nothing on screen showed, and with 279 catalog entries most of the
  // list was unreachable. `useListWindow`'s own window only moves when the selection would
  // otherwise land outside it (`handleArrowKey`), not recomputed fresh from the selection on every
  // render, which would re-center the window on every keypress instead of sliding it only when
  // actually needed.
  const {
    selected: selectedIndex,
    visible,
    remainingCount,
    handleArrowKey,
    reset: resetScroll,
  } = useListWindow(filtered);

  useInput((input, key) => {
    // Escape OR Ctrl-D — deliberately NOT ApprovalBox's Ctrl-D (which triggers app quit): this is
    // "never mind, back to typing", not a graceful-quit sequence.
    if (key.escape || (key.ctrl && input === "d")) {
      onModelPickerCancel?.();
      return;
    }
    if (handleArrowKey(key)) return;
    if (key.return) {
      const row = filtered[selectedIndex];
      if (row !== undefined) {
        onModelSelected?.({
          model: row.entry.id,
          provider: row.entry.provider,
          keyConfigured: row.keyConfigured,
        });
      }
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.backspace || key.delete) {
      setFilterQuery((query) => query.slice(0, -1));
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
      onModelSelected?.(
        { model: row.entry.id, provider: row.entry.provider, keyConfigured: row.keyConfigured },
        after || undefined,
      );
    }
  });

  return (
    <Box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <Text>{filterQuery.length > 0 ? filterQuery : " "}</Text>
      {/* Same reasoning as ListRow's own comment (components.tsx): MODEL_PICKER_HEADER's own fixed
      column widths sum to the same ~87 chars, so it soft-wraps on the identical narrow terminals
      the row's `wrap="truncate-end"` guards against. */}
      <Text color={theme.muted} wrap="truncate-end">{`  ${MODEL_PICKER_HEADER}`}</Text>
      {visible.map(({ row, isSelected }) => (
        <ListRow
          key={`${row.entry.provider}/${row.entry.id}`}
          selected={isSelected}
          label={formatModelRow(row)}
        />
      ))}
      {remainingCount > 0 && (
        <Text color={theme.muted}>+{remainingCount} more — keep typing to narrow</Text>
      )}
    </Box>
  );
}
