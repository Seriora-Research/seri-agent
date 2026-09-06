/** @jsxImportSource @opentui/react */
import { escapeControlChars } from "../../cli/output";
import type { FileChangeView } from "../../fileChange";
import { theme } from "../theme/theme";

function lineFg(kind: FileChangeView["lines"][number]["kind"]): string {
  if (kind === "add") return theme.diffAdd;
  if (kind === "del") return theme.diffDel;
  return theme.muted;
}

export function FileChangeLines({
  change,
  gap = 0,
}: {
  change: FileChangeView;
  gap?: 0 | 1;
}) {
  return (
    <box marginTop={gap} flexDirection="column" flexShrink={0}>
      <text fg={theme.muted} flexShrink={0} wrapMode="none" truncate>
        {escapeControlChars(`${change.title}  +${change.added} −${change.removed}`)}
      </text>
      {change.lines.map((line, index) => (
        <text key={index} fg={lineFg(line.kind)} flexShrink={0} wrapMode="none" truncate>
          {escapeControlChars(line.text)}
        </text>
      ))}
      {change.hidden > 0 ? (
        <text fg={theme.muted} flexShrink={0} wrapMode="none" truncate>
          {`… ${change.hidden} more`}
        </text>
      ) : null}
    </box>
  );
}
