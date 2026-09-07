/** @jsxImportSource @opentui/react */
import { theme } from "../theme/theme";
import type { CompletionItem } from "../util/completion";
import { remaining, truncatePad } from "../util/format";

export const COMPLETION_POPUP_ROWS = 6;

const VALUE_WIDTH = 24;

export function CompletionPopup({
  matches,
  selected,
  offset,
}: {
  matches: readonly CompletionItem[];
  // Indexes into the full match list, not the visible slice.
  selected: number;
  offset: number;
}) {
  if (matches.length === 0) return null;
  const visible = matches.slice(offset, offset + COMPLETION_POPUP_ROWS);
  const remainingCount = remaining(matches.length, offset, COMPLETION_POPUP_ROWS);
  return (
    <box flexDirection="column">
      {visible.map((item, index) => {
        const isSelected = offset + index === selected;
        // OpenTUI INVERSE sets a cell's background to its own foreground; use selectedBg/selectedFg instead.
        const fg = isSelected ? theme.selectedFg : undefined;
        const bg = isSelected ? theme.selectedBg : undefined;
        return (
          // A truncated text node with two children renders blank on overflow.
          <box key={item.value} flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={fg ?? theme.text} flexShrink={0}>
              {truncatePad(item.value, VALUE_WIDTH)}
            </text>
            <text bg={bg} fg={fg ?? theme.muted} truncate wrapMode="none" flexGrow={1}>
              {item.description}
            </text>
          </box>
        );
      })}
      {remainingCount > 0 && (
        <text fg={theme.muted}>+{remainingCount} more — keep typing to narrow</text>
      )}
    </box>
  );
}
