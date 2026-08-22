/** @jsxImportSource @opentui/react */
// Ported from panels/ModelPicker.tsx: same logic, OpenTUI's element/hook names.

import { decodePasteBytes, TextAttributes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import type { ModelProvider } from "@seri/model-catalog";
import { useState } from "react";
import type { ModelPickerEntry } from "../state/commands";
import { useListWindow } from "../hooks/useListWindow";
import { theme } from "../theme/theme";
import { ListRow } from "../ui/ListRow";
import { formatModelRow, MODEL_PICKER_HEADER, matchesFilter } from "../util/format";

const FILTER_PLACEHOLDER = 'Type to filter — try "free" or "paid"…';

// /model's own live state (tui/reducer.ts's pendingModelPicker) — mirrors ApprovalBox's shape
// exactly: its own keyboard handler, a single-bordered box, mutually exclusive with InputBox.
// `filterQuery` is local component state, not reducer state, for the same reason InputBox's own
// `value` is: this is transient UI data with no reason to survive a resolve/cancel or be visible
// to anything outside this component. The selection index is owned by useListWindow instead, for
// the same reason.
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

  function selectRow(row: ModelPickerEntry | undefined, leftoverInput?: string) {
    if (row === undefined) return;
    onModelSelected?.(
      { model: row.entry.id, provider: row.entry.provider, keyConfigured: row.keyConfigured },
      leftoverInput,
    );
  }

  useKeyboard((key) => {
    // Escape OR Ctrl-D — deliberately NOT ApprovalBox's Ctrl-D (which triggers app quit): this is
    // "never mind, back to typing", not a graceful-quit sequence.
    if (key.name === "escape" || (key.ctrl && key.name === "d")) {
      onModelPickerCancel?.();
      return;
    }
    if (handleArrowKey(key)) return;
    if (key.name === "return" || key.name === "kpenter" || key.name === "linefeed") {
      selectRow(filtered[selectedIndex]);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.name === "backspace" || key.name === "delete") {
      setFilterQuery((query) => query.slice(0, -1));
      resetScroll();
      return;
    }
    // A plain, printable keypress — see InputBox.tsx's own comment on `key.name.length === 1 ||
    // key.name === "space"` for why this is the OpenTUI equivalent of Ink's pre-filtered `input`
    // string. Each keypress is its own discrete event under OpenTUI's byte-level parser, unlike
    // Ink's `useInput`, which could hand a combined multi-character pty chunk (typed filter text
    // immediately followed by Enter) to one `input` call — the terminator-splitting this used to
    // need for that case moved to `usePaste` below, the only path a multi-character chunk can
    // still arrive through.
    if (
      !key.ctrl &&
      !key.meta &&
      key.sequence.length > 0 &&
      (key.name.length === 1 || key.name === "space")
    ) {
      setFilterQuery((query) => query + key.sequence);
      resetScroll();
    }
  });

  // OpenTUI delivers a terminal paste as its own event (bracketed paste), never through
  // `useKeyboard` — see InputBox.tsx's own comment. Mirrors its terminator-split logic: everything
  // before the first `\r`/`\n` narrows the filter and selects the top match now, same as pressing
  // Enter right there; everything after is handed to `onModelSelected` so it can prefill the very
  // next InputBox mount.
  usePaste((event) => {
    const text = decodePasteBytes(event.bytes);
    const terminatorIndex = text.search(/[\r\n]/);
    if (terminatorIndex === -1) {
      setFilterQuery((query) => query + text);
      resetScroll();
      return;
    }
    const before = text.slice(0, terminatorIndex);
    // A `\r\n` pair (a Windows-clipboard paste is the common source) is ONE terminator, not two.
    const terminatorLength = text.startsWith("\r\n", terminatorIndex) ? 2 : 1;
    const after = text.slice(terminatorIndex + terminatorLength);
    const nextQuery = filterQuery + before;
    const nextFiltered =
      nextQuery.length === 0 ? entries : entries.filter((row) => matchesFilter(row, nextQuery));
    selectRow(nextFiltered[0], after || undefined);
  });

  const promptText = filterQuery.length === 0 ? "> " : `> ${filterQuery}`;
  const showPlaceholder = filterQuery.length === 0;

  return (
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <box flexDirection="row">
        {/* Cursor sits immediately after the prompt/query, matching where a real caret belongs;
        the placeholder (empty filter only) renders after it instead of between them. `promptText`,
        the cursor, and the placeholder are three separate `<text>` siblings, the same shape
        ui/ListRow.tsx's own fix needed (see that file's comment): re-tested directly against
        OpenTUI's own layout engine, a bare cursor `<text>` sibling reliably keeps its own space at
        every terminal width tried, unlike Ink where pinning `flexShrink={0}` on it wasn't enough —
        so the original Ink-side arbitration bug does not reproduce here, and the manual JS
        truncation workaround it needed is not carried over. */}
        <text truncate>{promptText}</text>
        <text attributes={TextAttributes.INVERSE}> </text>
        {showPlaceholder && (
          <text truncate fg={theme.muted}>
            {FILTER_PLACEHOLDER}
          </text>
        )}
      </box>
      {/* The 2-space indent and the header text are separate `<text>` siblings, not one string —
      ui/ListRow.tsx's own comment explains why: a single truncated `<text>` whose content spans
      more than one child renders BLANK once it overflows, and `MODEL_PICKER_HEADER`'s own fixed
      column widths sum to ~87 chars, wider than a typical 80-column terminal once the border and
      indent are subtracted — this is the common case, not an edge case. */}
      <box flexDirection="row">
        <text fg={theme.muted}>{"  "}</text>
        <text fg={theme.muted} truncate>
          {MODEL_PICKER_HEADER}
        </text>
      </box>
      {visible.map(({ row, isSelected }) => (
        <ListRow
          key={`${row.entry.provider}/${row.entry.id}`}
          selected={isSelected}
          label={formatModelRow(row)}
        />
      ))}
      {remainingCount > 0 && (
        <text fg={theme.muted}>+{remainingCount} more — keep typing to narrow</text>
      )}
    </box>
  );
}
