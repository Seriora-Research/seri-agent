/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { ChildView, Dispatch } from "../state/reducer";
import { summarizeArgs } from "../state/toolActivity";
import { theme } from "../theme/theme";
import { isEnter } from "../util/keys";

export function SubagentPanel({
  subagents,
  focused,
  selectedId,
  dispatch,
}: {
  subagents: ChildView[];
  focused: boolean;
  selectedId: string | undefined;
  dispatch: Dispatch;
}) {
  useKeyboard((key) => {
    if (!focused) return;
    if (key.name === "escape") {
      dispatch({ type: "subagent-panel-blur" });
      return;
    }
    if (isEnter(key)) {
      if (selectedId !== undefined) dispatch({ type: "subagent-overlay-open", id: selectedId });
      return;
    }
    const index = subagents.findIndex((child) => child.id === selectedId);
    if (key.name === "down") {
      const next = subagents[Math.min(Math.max(index, 0) + 1, subagents.length - 1)];
      if (next !== undefined) dispatch({ type: "subagent-panel-select", id: next.id });
      return;
    }
    if (key.name === "up") {
      if (index <= 0) {
        dispatch({ type: "subagent-panel-blur" });
        return;
      }
      dispatch({ type: "subagent-panel-select", id: subagents[index - 1].id });
    }
  });

  return (
    <box flexDirection="column">
      {subagents.map((child) => (
        <SubagentRow
          key={child.id}
          child={child}
          siblings={subagents}
          selected={focused && child.id === selectedId}
        />
      ))}
    </box>
  );
}

function roleLabel(child: ChildView, siblings: ChildView[]): string {
  const sameRole = siblings.filter((row) => row.role === child.role);
  if (sameRole.length < 2) return child.role;
  return `${child.role} · ${sameRole.findIndex((row) => row.id === child.id) + 1}`;
}

function denialSuffix(child: ChildView): string | undefined {
  for (let i = child.toolActivity.length - 1; i >= 0; i--) {
    const anomaly = child.toolActivity[i].anomalyLines.find(
      (line) => line === "blocked" || line === "declined",
    );
    if (anomaly !== undefined) return anomaly;
  }
  return undefined;
}

function SubagentRow({
  child,
  siblings,
  selected,
}: {
  child: ChildView;
  siblings: ChildView[];
  selected: boolean;
}) {
  const tool =
    child.currentTool === undefined
      ? undefined
      : summarizeArgs(child.currentTool.name, child.currentTool.args);
  const suffix = denialSuffix(child);
  const rest = [child.goal, tool, suffix].filter((part) => part !== undefined && part.length > 0);
  return (
    <box flexDirection="row">
      <text flexShrink={0}>{selected ? "> " : "  "}</text>
      <text attributes={TextAttributes.BOLD} flexShrink={0}>
        {roleLabel(child, siblings)}
      </text>
      <text fg={theme.muted} truncate wrapMode="none">
        {rest.length === 0 ? "" : ` ${rest.join("  ")}`}
      </text>
    </box>
  );
}
