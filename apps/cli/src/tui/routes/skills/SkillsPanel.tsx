/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { useListWindow } from "../../hooks/useListWindow";
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

// /skills' own live state, in the same shape as every other list panel here: its own keyboard
// handler, a single-bordered box, mutually exclusive with InputBox. `filterQuery` is component
// state rather than reducer state for the same reason ModelPicker's is — transient UI data with no
// reason to survive a close.
export function SkillsPanel({
  rows,
  onSkillRun,
  onSkillsClose,
}: {
  rows: SkillsPanelRow[];
  // Enter runs the highlighted skill, the one action seri actually has for a skill. There is no
  // enable/disable to cycle: a skill is loadable because its file is there.
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
    <box borderStyle="single" borderColor={theme.muted} flexDirection="column">
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Skills
      </text>
      <text fg={theme.muted} truncate wrapMode="none">
        {`${rows.length} ${rows.length === 1 ? "skill" : "skills"} · ↑/↓ move · type to search · enter to run · esc to close`}
      </text>
      {/* The filter row's prompt, cursor and placeholder are three separate `<text>` siblings for
      the reason ModelPicker's own filter row documents: a single truncated `<text>` spanning more
      than one child renders blank the instant it overflows. */}
      <box flexDirection="row">
        <text flexShrink={0}>{filterQuery.length === 0 ? "> " : `> ${filterQuery}`}</text>
        <text attributes={TextAttributes.INVERSE} flexShrink={0}>
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
          {/* The description is shown for the highlighted row only, not on every row: it is a
          sentence, and a column of sentences would crowd out the list it is describing. */}
          {selectedRow !== undefined && (
            <text fg={theme.muted} truncate wrapMode="none">
              {selectedRow.description.length === 0
                ? "(no description — the model is never told this skill exists)"
                : selectedRow.description}
            </text>
          )}
        </>
      )}
    </box>
  );
}
