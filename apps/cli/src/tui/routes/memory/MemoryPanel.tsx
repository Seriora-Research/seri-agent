/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { MemoryPanelRow } from "../../../memory/commands";
import { useListWindow } from "../../hooks/useListWindow";
import { PanelBox } from "../../ui/PanelBox";
import { theme } from "../../theme/theme";
import { ListRow } from "../../ui/ListRow";
import { formatMemoryRow, MEMORY_PANEL_HEADER, singleLine } from "../../util/format";
import { isDismiss, isEnter, isPrintableKey } from "../../util/keys";

type DiffLine = { key: string; text: string };
type Mode = { kind: "list" } | { kind: "diff"; row: MemoryPanelRow; lines: DiffLine[] };

function diffLinesFor(row: MemoryPanelRow, onDiff?: (id: string) => string[]): DiffLine[] {
  return (onDiff?.(row.id) ?? []).map((text, index) => ({ key: `${row.id}:${index}`, text }));
}

export function MemoryPanel({
  rows,
  onDiff,
  onApprove,
  onReject,
  onMemoryClose,
}: {
  rows: readonly MemoryPanelRow[];
  onDiff?: (id: string) => string[];
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  onMemoryClose?: () => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const { selected, visible, remainingCount, handleArrowKey } = useListWindow(rows);

  useKeyboard((key) => {
    if (mode.kind === "diff") return;
    if (isDismiss(key)) {
      onMemoryClose?.();
      return;
    }
    if (handleArrowKey(key)) return;
    const row = rows[selected];
    if (row === undefined) return;
    if (isEnter(key)) {
      setMode({ kind: "diff", row, lines: diffLinesFor(row, onDiff) });
      return;
    }
    if (!isPrintableKey(key)) return;
    const pressed = key.sequence.toLowerCase();
    if (pressed === "a") onApprove?.(row.id);
    else if (pressed === "r") onReject?.(row.id);
  });

  if (mode.kind === "diff") {
    return (
      <MemoryDiffView
        row={mode.row}
        lines={mode.lines}
        onApprove={() => {
          onApprove?.(mode.row.id);
          setMode({ kind: "list" });
        }}
        onReject={() => {
          onReject?.(mode.row.id);
          setMode({ kind: "list" });
        }}
        onBack={() => setMode({ kind: "list" })}
      />
    );
  }

  const selectedRow = rows[selected];

  return (
    <PanelBox title="Memory">
      {rows.length === 0 ? (
        <text fg={theme.muted} truncate wrapMode="none">
          No staged memory writes.
        </text>
      ) : (
        <>
          <text fg={theme.muted} truncate wrapMode="none">
            {`${rows.length} staged ${rows.length === 1 ? "write" : "writes"}`}
          </text>
          <box flexDirection="row">
            <text fg={theme.muted}>{"  "}</text>
            <text fg={theme.muted} truncate wrapMode="none">
              {MEMORY_PANEL_HEADER}
            </text>
          </box>
          {visible.map(({ row, isSelected }) => (
            <ListRow key={row.id} selected={isSelected} label={formatMemoryRow(row)} />
          ))}
          {remainingCount > 0 && <text fg={theme.muted}>↓ {remainingCount} more below</text>}
          {selectedRow !== undefined && (
            <text fg={theme.muted} truncate wrapMode="none">
              {singleLine(`${selectedRow.id.slice(0, 7)} · ${selectedRow.reason}`)}
            </text>
          )}
        </>
      )}
      <text fg={theme.muted} truncate wrapMode="none">
        {rows.length === 0
          ? "esc close"
          : "↑/↓ move · enter preview · a approve · r reject · esc close"}
      </text>
    </PanelBox>
  );
}

function MemoryDiffView({
  row,
  lines,
  onApprove,
  onReject,
  onBack,
}: {
  row: MemoryPanelRow;
  lines: readonly DiffLine[];
  onApprove: () => void;
  onReject: () => void;
  onBack: () => void;
}) {
  const { visible, remainingCount, handleArrowKey } = useListWindow(lines);

  useKeyboard((key) => {
    if (isDismiss(key) || isEnter(key)) {
      onBack();
      return;
    }
    if (handleArrowKey(key)) return;
    if (!isPrintableKey(key)) return;
    const pressed = key.sequence.toLowerCase();
    if (pressed === "a") onApprove();
    else if (pressed === "r") onReject();
  });

  return (
    <PanelBox title="Memory">
      <text fg={theme.text} attributes={TextAttributes.BOLD} truncate wrapMode="none">
        {`${row.action} ${row.file}`}
      </text>
      {visible.map(({ row: line }) => (
        <text
          key={line.key}
          fg={line.text.startsWith("+ ") || line.text.startsWith("- ") ? theme.text : theme.muted}
          truncate
          wrapMode="none"
        >
          {singleLine(line.text)}
        </text>
      ))}
      {remainingCount > 0 && <text fg={theme.muted}>↓ {remainingCount} more below</text>}
      <text fg={theme.muted} truncate wrapMode="none">
        ↑/↓ scroll · a approve · r reject · esc back
      </text>
    </PanelBox>
  );
}
