/** @jsxImportSource @opentui/react */
import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import type { ModelProvider } from "@seri/model-catalog";
import { useState } from "react";
import { useClipboardPaste } from "../hooks/useClipboardPaste";
import { useListWindow } from "../hooks/useListWindow";
import type { ModelPickerEntry } from "../state/commands";
import { PanelBox } from "../ui/PanelBox";
import { theme } from "../theme/theme";
import { ListRow } from "../ui/ListRow";
import {
  DEFAULT_COLUMNS,
  formatModelPickerHeader,
  formatModelRow,
  matchesFilter,
  pickerLabelWidth,
} from "../util/format";
import { isDismiss, isEnter, isPrintableKey, splitAtTerminator } from "../util/keys";

const FILTER_PLACEHOLDER = 'Type to filter — try "included", "free" or "paid"…';

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
  const { width: rawWidth } = useTerminalDimensions();
  const labelWidth = pickerLabelWidth(rawWidth || DEFAULT_COLUMNS);

  const filtered =
    filterQuery.length === 0 ? entries : entries.filter((row) => matchesFilter(row, filterQuery));

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
    if (isPrintableKey(key)) {
      setFilterQuery((query) => query + key.sequence);
      resetScroll();
    }
  });

  // OpenTUI delivers paste as its own event; a terminator in the chunk selects now and prefills leftover input.
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

  // Ctrl-V is not a paste event; share insertPastedText with usePaste.
  useClipboardPaste(insertPastedText);

  const promptText = filterQuery.length === 0 ? "> " : `> ${filterQuery}`;
  const showPlaceholder = filterQuery.length === 0;

  return (
    <PanelBox title="/model">
      <box flexDirection="row">
        {/* OpenTUI defaults flexShrink to 1, which shrinks promptText including its trailing space once the placeholder no longer fits. wrapMode none is required for truncate to clip instead of wrap. */}
        <text flexShrink={0}>{promptText}</text>
        <text fg={theme.onInk} bg={theme.accent} flexShrink={0}>
          {" "}
        </text>
        {showPlaceholder && (
          <text truncate wrapMode="none" fg={theme.muted}>
            {FILTER_PLACEHOLDER}
          </text>
        )}
      </box>
      {/* A single truncated text node whose content spans more than one child renders blank on overflow. */}
      <box flexDirection="row">
        <text fg={theme.muted}>{"  "}</text>
        <text fg={theme.muted} truncate>
          {formatModelPickerHeader(labelWidth)}
        </text>
      </box>
      {visible.map(({ row, isSelected }) => (
        <ListRow
          key={`${row.entry.provider}/${row.entry.id}`}
          selected={isSelected}
          label={formatModelRow(row, labelWidth)}
        />
      ))}
      {remainingCount > 0 && (
        <text fg={theme.muted}>+{remainingCount} more — keep typing to narrow</text>
      )}
    </PanelBox>
  );
}
