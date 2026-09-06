/** @jsxImportSource @opentui/react */
import { escapeControlChars } from "../../cli/output";
import type { DiffLineKind, FileChangeView } from "../../fileChange";
import { theme } from "../theme/theme";

function lineFg(kind: DiffLineKind): string {
  if (kind === "add") return theme.diffAdd;
  if (kind === "del") return theme.diffDel;
  return theme.muted;
}

function barColor(kind: DiffLineKind): string | undefined {
  if (kind === "add") return theme.diffAdd;
  if (kind === "del") return theme.diffDel;
  return undefined;
}

function HunkRow({ kind, text }: { kind: DiffLineKind; text: string }) {
  const bar = barColor(kind);
  return (
    <box flexDirection="row" flexShrink={0}>
      <box width={1} flexShrink={0} backgroundColor={bar} />
      <text fg={lineFg(kind)} flexShrink={0} wrapMode="none" truncate>
        {escapeControlChars(text)}
      </text>
    </box>
  );
}

export function FileChangeStatsLine({
  added,
  removed,
  gap = 0,
}: {
  added: number;
  removed: number;
  gap?: 0 | 1;
}) {
  return (
    <box marginTop={gap} flexDirection="row" flexShrink={0}>
      <text fg={theme.diffAdd} flexShrink={0}>
        {`+${added}`}
      </text>
      <text fg={theme.muted} flexShrink={0}>
        {" "}
      </text>
      <text fg={theme.diffDel} flexShrink={0}>
        {`−${removed}`}
      </text>
    </box>
  );
}

export function FileChangeLines({ change, gap = 0 }: { change: FileChangeView; gap?: 0 | 1 }) {
  return (
    <box marginTop={gap} flexDirection="column" flexShrink={0}>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.muted} flexShrink={0} wrapMode="none" truncate>
          {escapeControlChars(`${change.title}  `)}
        </text>
        <text fg={theme.diffAdd} flexShrink={0} wrapMode="none">
          {`+${change.added}`}
        </text>
        <text fg={theme.muted} flexShrink={0} wrapMode="none">
          {" "}
        </text>
        <text fg={theme.diffDel} flexShrink={0} wrapMode="none">
          {`−${change.removed}`}
        </text>
      </box>
      {change.lines.map((line, index) => (
        <HunkRow key={index} kind={line.kind} text={line.text} />
      ))}
      {change.hidden > 0 ? (
        <text fg={theme.muted} flexShrink={0} wrapMode="none" truncate>
          {`… ${change.hidden} more`}
        </text>
      ) : null}
    </box>
  );
}
