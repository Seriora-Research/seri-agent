/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";
import type { ChildView, Dispatch } from "../state/reducer";
import { summarizeArgs } from "../state/toolActivity";
import { theme } from "../theme/theme";
import { isEnter } from "../util/keys";

const CHILD_WINDOW = 3;

export function childWindowOffset(
  selectedId: string | undefined,
  childIds: readonly string[],
): number {
  if (selectedId === undefined || selectedId === "main") return 0;
  const selectedIndex = childIds.indexOf(selectedId);
  if (selectedIndex < 0) return 0;
  const maxOffset = Math.max(0, childIds.length - CHILD_WINDOW);
  return Math.min(Math.max(selectedIndex - 2, 0), maxOffset);
}

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
  const childIds = subagents.map((child) => child.id);
  const walkIds = ["main", ...childIds];

  useKeyboard((key) => {
    if (!focused) return;
    if (key.name === "escape") {
      dispatch({ type: "subagent-panel-blur" });
      return;
    }
    if (isEnter(key)) {
      if (selectedId === undefined || selectedId === "main") {
        dispatch({ type: "subagent-overlay-close" });
        return;
      }
      dispatch({ type: "subagent-overlay-open", id: selectedId });
      return;
    }
    const index = Math.max(0, walkIds.indexOf(selectedId ?? "main"));
    if (key.name === "down") {
      const next = walkIds[Math.min(index + 1, walkIds.length - 1)];
      if (next !== undefined) dispatch({ type: "subagent-panel-select", id: next });
      return;
    }
    if (key.name === "up") {
      if (index <= 0) {
        dispatch({ type: "subagent-panel-blur" });
        return;
      }
      dispatch({ type: "subagent-panel-select", id: walkIds[index - 1] });
    }
  });

  const offset = childWindowOffset(selectedId, childIds);
  const visible = subagents.slice(offset, offset + CHILD_WINDOW);
  const overflow = subagents.length - (offset + CHILD_WINDOW);

  return (
    <box flexDirection="column">
      <RosterRow selected={focused && (selectedId === undefined || selectedId === "main")}>
        <text attributes={TextAttributes.BOLD} flexShrink={0}>
          main
        </text>
      </RosterRow>
      {visible.map((child) => (
        <SubagentRow key={child.id} child={child} selected={focused && child.id === selectedId} />
      ))}
      {overflow > 0 && <text fg={theme.muted}>{`  +${overflow}`}</text>}
    </box>
  );
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

function RosterRow({ selected, children }: { selected: boolean; children: ReactNode }) {
  return (
    <box flexDirection="row">
      <text flexShrink={0}>{selected ? "> " : "  "}</text>
      {children}
    </box>
  );
}

function SubagentRow({ child, selected }: { child: ChildView; selected: boolean }) {
  const tool =
    child.currentTool === undefined
      ? undefined
      : summarizeArgs(child.currentTool.name, child.currentTool.args);
  const suffix = denialSuffix(child);
  const rest = [tool, suffix].filter((part) => part !== undefined && part.length > 0);
  return (
    <RosterRow selected={selected}>
      <text attributes={TextAttributes.BOLD} flexShrink={0}>
        {child.role}
      </text>
      <text fg={theme.muted} truncate wrapMode="none">
        {rest.length === 0 ? "" : ` ${rest.join("  ")}`}
      </text>
    </RosterRow>
  );
}
