/** @jsxImportSource @opentui/react */
import { escapeControlChars } from "../../cli/output";
import type { DiffLineKind, FileChangeLine, FileChangeView } from "../../fileChange";
import { theme } from "../theme/theme";

// Left one-eighth block. A 1-col `backgroundColor` of `diffAdd`/`diffDel` fills the whole cell and
// reads as a crayon; this glyph is the thinnest edge a terminal can draw on top of the wash.
const DIFF_EDGE = "▏";

function hunkBody(text: string): string {
  if (text.startsWith("+ ") || text.startsWith("- ") || text.startsWith("  ")) {
    return text.slice(2);
  }
  return text;
}

function numberWidth(lines: FileChangeLine[]): number {
  let width = 0;
  for (const line of lines) {
    if (line.lineNumber === undefined) continue;
    width = Math.max(width, String(line.lineNumber).length);
  }
  return Math.min(4, width);
}

function HunkRow({
  kind,
  text,
  lineLabel,
}: {
  kind: DiffLineKind;
  text: string;
  lineLabel: string;
}) {
  const wash = kind === "add" ? theme.diffAddBg : kind === "del" ? theme.diffDelBg : undefined;
  const edge = kind === "add" ? theme.diffAdd : kind === "del" ? theme.diffDel : undefined;
  return (
    <box flexDirection="row" flexShrink={0} alignSelf="flex-start">
      <text fg={edge ?? theme.muted} bg={wash} flexShrink={0} wrapMode="none">
        {edge !== undefined ? DIFF_EDGE : " "}
      </text>
      {lineLabel.length > 0 ? (
        <text fg={theme.muted} bg={wash} flexShrink={0} wrapMode="none">
          {lineLabel}
        </text>
      ) : null}
      <text
        fg={kind === "context" ? theme.muted : theme.text}
        bg={wash}
        flexShrink={0}
        wrapMode="none"
        truncate
      >
        {escapeControlChars(hunkBody(text))}
      </text>
    </box>
  );
}

export function FileChangeStatsLine({
  added,
  removed,
}: {
  added: number;
  removed: number;
}) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={theme.diffAdd} flexShrink={0} wrapMode="none">
        {`+${added}`}
      </text>
      <text fg={theme.muted} flexShrink={0} wrapMode="none">
        {" "}
      </text>
      <text fg={theme.diffDel} flexShrink={0} wrapMode="none">
        {`−${removed}`}
      </text>
    </box>
  );
}

export function FileChangeLines({ change, gap = 0 }: { change: FileChangeView; gap?: 0 | 1 }) {
  const width = numberWidth(change.lines);
  return (
    <box marginTop={gap} flexDirection="column" flexShrink={0} alignSelf="flex-start">
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.muted} flexShrink={0} wrapMode="none" truncate>
          {escapeControlChars(`${change.title}  `)}
        </text>
        <FileChangeStatsLine added={change.added} removed={change.removed} />
      </box>
      {change.lines.map((line, index) => (
        <HunkRow
          key={index}
          kind={line.kind}
          text={line.text}
          lineLabel={
            width === 0 || line.lineNumber === undefined
              ? ""
              : `${String(line.lineNumber).padStart(width)} `
          }
        />
      ))}
      {change.hidden > 0 ? (
        <text fg={theme.muted} flexShrink={0} wrapMode="none" truncate>
          {`… ${change.hidden} more`}
        </text>
      ) : null}
    </box>
  );
}
