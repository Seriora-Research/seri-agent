/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { MemoryPanelRow } from "../../../memory/commands";
import { useListWindow } from "../../hooks/useListWindow";
import { theme } from "../../theme/theme";
import { ListRow } from "../../ui/ListRow";
import { formatMemoryRow, MEMORY_PANEL_HEADER, singleLine } from "../../util/format";
import { isDismiss, isEnter, isPrintableKey } from "../../util/keys";

// /memory's own live state — SkillsPanel's structure (bordered box, header, useListWindow) with
// one extra mode: a staged write is a proposed edit to a file the model will later read back as
// instructions, so previewing it before deciding is the review this panel exists for. `diff` holds
// the rendered lines rather than the row's id, because computing them is disk I/O cli.ts owns
// (memoryDiffLines) and this component is not the place to re-run it on every render.
//
// A diff line paired with an identity of its own. `<id>:<n>` rather than the array index alone:
// the index is genuinely what identifies a diff line (nothing reorders or splices this list), but
// two different rows' previews would key their Nth lines identically, so the row id goes in front.
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
  /** Renders one staged write against the CURRENT live file — never a snapshot taken at stage
   *  time, which is the difference between previewing what approving would do and what it would
   *  have done. Returns the failure as lines, so every ending has something to show. */
  onDiff?: (id: string) => string[];
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  onMemoryClose?: () => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const { selected, visible, remainingCount, handleArrowKey } = useListWindow(rows);

  useKeyboard((key) => {
    // The early return below renders MemoryDiffView INSTEAD of this panel, but it sits after this
    // hook, so without this guard both handlers stay live and every key reaches the list
    // underneath — the same leak McpPanel's own preview guard documents, where "r" at a prompt
    // both answered the prompt and acted on the row behind it in one keypress.
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
    // Enter is the preview, not the approval: approving writes to a file the model reads back as
    // instructions, and the easiest key to hit by accident should be the one that only shows you
    // something. Both decisions are a deliberate letter, available from here and from the preview.
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
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Memory
      </text>
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
          {/* The reason is shown for the highlighted row only, not on every row: it is a sentence,
          and a column of sentences would crowd out the list it is describing — the same call
          SkillsPanel makes for a skill's description. */}
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
    </box>
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
  // The same windowed list every other panel scrolls with, over diff lines rather than rows: a
  // replace against a full MEMORY.md renders more lines than any terminal shows, and a preview
  // that silently drops its tail is worse than no preview.
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
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.text} attributes={TextAttributes.BOLD} truncate wrapMode="none">
        {`${row.action} ${row.file}`}
      </text>
      {visible.map(({ row: line }) => (
        <text
          // Context lines carry no decision, so they recede; an added or removed line is the thing
          // being decided and stays at full weight. The `+ `/`- ` prefixes diffLines already emits
          // are what distinguishes the two, per docs/design/tui.md's mark-not-color rule.
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
    </box>
  );
}
