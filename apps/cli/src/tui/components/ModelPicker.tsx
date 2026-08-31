/** @jsxImportSource @opentui/react */
// Ported from panels/ModelPicker.tsx: same logic, OpenTUI's element/hook names.

import { decodePasteBytes, TextAttributes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import type { ModelProvider } from "@seri/model-catalog";
import { useState } from "react";
import { useClipboardPaste } from "../hooks/useClipboardPaste";
import { useListWindow } from "../hooks/useListWindow";
import type { ModelPickerEntry } from "../state/commands";
import { FRAME } from "../theme/spacing";
import { theme } from "../theme/theme";
import { ListRow } from "../ui/ListRow";
import { formatModelRow, MODEL_PICKER_HEADER, matchesFilter } from "../util/format";
import { isDismiss, isEnter, isPrintableKey, splitAtTerminator } from "../util/keys";

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
    if (isDismiss(key)) {
      onModelPickerCancel?.();
      return;
    }
    if (handleArrowKey(key)) return;
    if (isEnter(key)) {
      selectRow(filtered[selectedIndex]);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.name === "backspace" || key.name === "delete") {
      setFilterQuery((query) => query.slice(0, -1));
      resetScroll();
      return;
    }
    // A plain, printable keypress (util/keys.ts's own comment explains the OpenTUI-vs-Ink
    // distinction `isPrintableKey` reconstructs). Each keypress is its own discrete event under
    // OpenTUI's byte-level parser, unlike Ink's `useInput`, which could hand a combined
    // multi-character pty chunk (typed filter text immediately followed by Enter) to one `input`
    // call — the terminator-splitting this used to need for that case moved to `usePaste` below,
    // the only path a multi-character chunk can still arrive through.
    if (isPrintableKey(key)) {
      setFilterQuery((query) => query + key.sequence);
      resetScroll();
    }
  });

  // OpenTUI delivers a terminal paste as its own event (bracketed paste), never through
  // `useKeyboard` — see InputBox.tsx's own comment. `splitAtTerminator` (util/keys.ts) applies the
  // same way: everything before the first `\r`/`\n` narrows the filter and selects the top match
  // now, same as pressing Enter right there; everything after is handed to `onModelSelected` so it
  // can prefill the very next InputBox mount.
  function insertPastedText(text: string) {
    const split = splitAtTerminator(text);
    if (split === null) {
      setFilterQuery((query) => query + text);
      resetScroll();
      return;
    }
    const nextQuery = filterQuery + split.before;
    const nextFiltered =
      nextQuery.length === 0 ? entries : entries.filter((row) => matchesFilter(row, nextQuery));
    selectRow(nextFiltered[0], split.after || undefined);
  }

  usePaste((event) => insertPastedText(decodePasteBytes(event.bytes)));

  // Ctrl-V, which no terminal turns into the paste event above — see the hook's own comment. Shares
  // `insertPastedText` so the two paste paths cannot drift on what an embedded terminator does.
  useClipboardPaste(insertPastedText);

  const promptText = filterQuery.length === 0 ? "> " : `> ${filterQuery}`;
  const showPlaceholder = filterQuery.length === 0;

  return (
    <box {...FRAME} flexDirection="column">
      <box flexDirection="row">
        {/* Cursor sits immediately after the prompt/query, matching where a real caret belongs;
        the placeholder (empty filter only) renders after it instead of between them. `promptText`,
        the cursor, and the placeholder are three separate `<text>` siblings, the same shape
        ui/ListRow.tsx's own fix needed (see that file's comment). `flexShrink={0}` on `promptText`
        and the cursor is required, the same as ListRow's own marker — without it, the row's flex
        layout shrinks `promptText` (dropping its own trailing space) once the placeholder no
        longer fits at a narrow width, even with an EMPTY filter query where the cursor itself was
        never the thing squeezed. Only the placeholder (the one sibling that should lose width)
        keeps `truncate`; `wrapMode="none"` on it is required too, the same as ListRow's own label,
        for `truncate` to clip instead of soft-wrap the placeholder across two lines. */}
        <text flexShrink={0}>{promptText}</text>
        <text attributes={TextAttributes.INVERSE} flexShrink={0}>
          {" "}
        </text>
        {showPlaceholder && (
          <text truncate wrapMode="none" fg={theme.muted}>
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
