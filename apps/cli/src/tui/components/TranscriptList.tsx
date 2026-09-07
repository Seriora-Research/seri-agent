/** @jsxImportSource @opentui/react */
import { getTreeSitterClient } from "@opentui/core";
import { memo } from "react";
import { useTranscriptWindow, type TranscriptWindowMetrics } from "../hooks/useTranscriptWindow";
import { gapBefore, TOOL_INDENT } from "../theme/spacing";
import { syntaxStyle } from "../theme/syntaxStyle";
import { theme } from "../theme/theme";
import { formatReasoningCaret, systemEntryFg, type TranscriptEntry } from "../util/format";
import { FileChangeLines } from "./FileChangeLines";

export function indentReasoningBody(body: string): string {
  const pad = `${TOOL_INDENT}${TOOL_INDENT}`;
  return body
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

export const TranscriptList = memo(function TranscriptList({
  transcript,
  scrollTop,
  viewportHeight,
  sticky,
  columns,
}: {
  transcript: TranscriptEntry[];
  scrollTop?: number;
  viewportHeight?: number;
  sticky?: boolean;
  columns?: number;
}) {
  const metrics: TranscriptWindowMetrics | undefined =
    viewportHeight === undefined ||
    sticky === undefined ||
    scrollTop === undefined ||
    columns === undefined
      ? undefined
      : { scrollTop, viewportHeight, sticky, columns };
  const { start, end, topSpacer, bottomSpacer, onRowSizeChange } = useTranscriptWindow(
    transcript.length,
    metrics,
  );

  if (metrics === undefined) {
    return (
      <>
        {transcript.map((entry, index) => (
          <TranscriptRow
            key={index}
            entry={entry}
            gap={gapBefore(
              transcript[index - 1]?.role,
              entry.role,
              transcript[index - 1]?.kind,
              entry.kind,
            )}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {topSpacer > 0 && <box height={topSpacer} flexShrink={0} />}
      {transcript.slice(start, end).map((entry, offset) => {
        const index = start + offset;
        return (
          <box key={index} flexShrink={0} onSizeChange={onRowSizeChange(index)}>
            <TranscriptRow
              entry={entry}
              gap={gapBefore(
                transcript[index - 1]?.role,
                entry.role,
                transcript[index - 1]?.kind,
                entry.kind,
              )}
            />
          </box>
        );
      })}
      {bottomSpacer > 0 && <box height={bottomSpacer} flexShrink={0} />}
    </>
  );
});

const BULLET = "●";
const BULLET_GUTTER = BULLET.length + 1;

// OpenTUI row-flex never grows a sibling to wrapped markdown height, so the bullet is position absolute. Padding cells are not text nodes; a drag starting on padding selects nothing.
const TranscriptRow = memo(function TranscriptRow({
  entry,
  gap,
}: {
  entry: TranscriptEntry;
  gap: 0 | 1;
}) {
  if (entry.role === "assistant") {
    return (
      // Without an in-flow bullet, OpenTUI sizes this box from markdown alone; whitespace-only content measures 0 rows.
      <box minHeight={1} marginTop={gap}>
        <text fg={theme.text} position="absolute" top={0} left={0}>
          {BULLET}
        </text>
        <markdown
          paddingLeft={BULLET_GUTTER}
          fg={theme.text}
          content={entry.text}
          syntaxStyle={syntaxStyle}
          treeSitterClient={getTreeSitterClient()}
          streaming={false}
        />
      </box>
    );
  }
  if (entry.role === "user") {
    return (
      <box backgroundColor={theme.userBg} marginTop={gap}>
        <text fg={theme.text}>{entry.text}</text>
      </box>
    );
  }
  if (entry.kind === "reasoning") {
    const caret = formatReasoningCaret(entry.expanded === true, entry.elapsedMs ?? 0);
    return (
      <box marginTop={gap} flexDirection="column">
        <text fg={theme.muted}>
          {TOOL_INDENT}
          {caret}
        </text>
        {entry.expanded === true && entry.body !== undefined && entry.body.length > 0 ? (
          <text fg={theme.muted}>{indentReasoningBody(entry.body)}</text>
        ) : null}
      </box>
    );
  }
  if (entry.kind === "file-change" && entry.fileChange !== undefined) {
    return <FileChangeLines change={entry.fileChange} gap={gap} />;
  }
  if (entry.role === "system" && entry.muted && entry.markdown) {
    return (
      <markdown
        marginTop={gap}
        fg={theme.muted}
        content={entry.text}
        syntaxStyle={syntaxStyle}
        treeSitterClient={getTreeSitterClient()}
        streaming={false}
      />
    );
  }
  return (
    <text marginTop={gap} fg={systemEntryFg(entry)}>
      {entry.text}
    </text>
  );
});
