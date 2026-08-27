/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import type { ChildView } from "../state/reducer";
import { renderLiveToolActivity, summarizeArgs } from "../state/toolActivity";
import { theme } from "../theme/theme";
import { TranscriptList } from "./TranscriptList";

const HEADER_GOAL_CHARS = 40;

export function ChildTranscript({ child }: { child: ChildView | undefined }) {
  if (child === undefined) return null;
  const headerGoal =
    child.goal.length > HEADER_GOAL_CHARS ? child.goal.slice(0, HEADER_GOAL_CHARS) : child.goal;
  const current =
    child.currentTool === undefined
      ? undefined
      : summarizeArgs(child.currentTool.name, child.currentTool.args);

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text attributes={TextAttributes.BOLD} flexShrink={0}>
          {child.role}
        </text>
        <text fg={theme.muted} truncate wrapMode="none">
          {headerGoal.length === 0 ? "" : ` ${headerGoal}`}
        </text>
      </box>
      <TranscriptList transcript={child.transcript} />
      {renderLiveToolActivity(child.toolActivity).map((line, index) => (
        <text key={index} fg={theme.muted}>
          {line}
        </text>
      ))}
      {current !== undefined && current.length > 0 && (
        <text fg={theme.muted}>{current}</text>
      )}
    </box>
  );
}
