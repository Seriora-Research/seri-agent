/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { useListWindow } from "../../hooks/useListWindow";
import { PanelBox } from "../../ui/PanelBox";
import { theme } from "../../theme/theme";
import { ListRow } from "../../ui/ListRow";
import {
  formatSkillRow,
  matchesSkillFilter,
  SKILLS_PANEL_HEADER,
  type SkillsPanelRow,
} from "../../util/format";
import { isDismiss, isEnter, isPrintableKey } from "../../util/keys";

const FILTER_PLACEHOLDER = "Search skills…";

export function SkillsPanel({
  rows,
  onSkillRun,
  onSkillsClose,
}: {
  rows: SkillsPanelRow[];
  onSkillRun?: (name: string) => void;
  onSkillsClose?: () => void;
}) {
  const [filterQuery, setFilterQuery] = useState("");

  const filtered =
    filterQuery.length === 0 ? rows : rows.filter((row) => matchesSkillFilter(row, filterQuery));

  const {
    selected: selectedIndex,
    visible,
    remainingCount,
    handleArrowKey,
    reset: resetScroll,
  } = useListWindow(filtered);

  useKeyboard((key) => {
    if (isDismiss(key)) {
      onSkillsClose?.();
      return;
    }
    if (handleArrowKey(key)) return;
    if (isEnter(key)) {
      const row = filtered[selectedIndex];
      if (row !== undefined) onSkillRun?.(row.name);
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

  const selectedRow = filtered[selectedIndex];

  return (
    <PanelBox title="Skills">
      <text fg={theme.muted} truncate wrapMode="none">
        {`${rows.length} ${rows.length === 1 ? "skill" : "skills"} · ↑/↓ move · type to search · enter to run · esc to close`}
      </text>
      {/* OpenTUI paints a blank line if one truncated <text> has multiple children. */}
      <box flexDirection="row">
        <text flexShrink={0}>{filterQuery.length === 0 ? "> " : `> ${filterQuery}`}</text>
        <text fg={theme.onInk} bg={theme.accent} flexShrink={0}>
          {" "}
        </text>
        {filterQuery.length === 0 && (
          <text truncate wrapMode="none" fg={theme.muted}>
            {FILTER_PLACEHOLDER}
          </text>
        )}
      </box>
      {rows.length === 0 ? (
        <text fg={theme.muted} truncate wrapMode="none">
          No skills yet. Add one at .seri/skills/&lt;name&gt;/SKILL.md
        </text>
      ) : (
        <>
          <box flexDirection="row">
            <text fg={theme.muted}>{"  "}</text>
            <text fg={theme.muted} truncate wrapMode="none">
              {SKILLS_PANEL_HEADER}
            </text>
          </box>
          {visible.map(({ row, isSelected }) => (
            <ListRow
              key={`${row.scope}/${row.name}`}
              selected={isSelected}
              label={formatSkillRow(row)}
            />
          ))}
          {remainingCount > 0 && <text fg={theme.muted}>↓ {remainingCount} more below</text>}
          {selectedRow !== undefined && (
            <text fg={theme.muted} truncate wrapMode="none">
              {selectedRow.description.length === 0
                ? "(no description — the model is never told this skill exists)"
                : selectedRow.description}
            </text>
          )}
        </>
      )}
    </PanelBox>
  );
}
