/** @jsxImportSource @opentui/react */
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { RefObject } from "react";
import type { ChildView, Dispatch } from "../state/reducer";
import { renderLiveToolActivity, summarizeArgs } from "../state/toolActivity";
import { theme } from "../theme/theme";
import { TranscriptList } from "./TranscriptList";

export function ChildTranscript({
  child,
  dispatch,
  scrollRef,
}: {
  child: ChildView | undefined;
  dispatch: Dispatch;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
}) {
  const { height: rows } = useTerminalDimensions();
  // Definite height, not flexGrow: a flex-sized scrollbox here would steal sibling rows the same
  // way the parent transcript's scrollbox does. Chrome below (live rows + mode footer) plus this
  // header is a handful of rows; floor at 3 so a short terminal still shows the child's last tool.
  const scrollHeight = Math.max(3, rows - 8);

  useKeyboard((key) => {
    if (key.name === "escape") dispatch({ type: "subagent-overlay-close" });
  });

  const current =
    child?.currentTool === undefined
      ? undefined
      : summarizeArgs(child.currentTool.name, child.currentTool.args);

  return (
    <box flexDirection="column">
      {child !== undefined && (
        <box flexDirection="row">
          <text attributes={TextAttributes.BOLD} flexShrink={0}>
            {child.role}
          </text>
          <text fg={theme.muted} truncate wrapMode="none">
            {` ${child.goal}`}
          </text>
        </box>
      )}
      <scrollbox ref={scrollRef} height={scrollHeight} stickyScroll stickyStart="bottom">
        {child !== undefined && (
          <>
            <TranscriptList transcript={child.transcript} />
            {renderLiveToolActivity(child.toolActivity).map((line, index) => (
              <text key={index} fg={theme.muted}>
                {line}
              </text>
            ))}
            {current !== undefined && current.length > 0 && (
              <text fg={theme.muted}>{current}</text>
            )}
          </>
        )}
      </scrollbox>
    </box>
  );
}
