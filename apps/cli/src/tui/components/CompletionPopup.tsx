/** @jsxImportSource @opentui/react */
import { theme } from "../theme/theme";
import type { CompletionItem } from "../util/completion";
import { remaining, truncatePad } from "../util/format";

// How many rows the popup may take. It sits directly above the input box and pushes the transcript
// up by this much in the worst case, so it is deliberately short: a user narrows by typing one more
// character far faster than they arrow through a long list.
export const COMPLETION_POPUP_ROWS = 6;

// The value column's width. Wide enough for the longest realistic command or skill name without the
// descriptions starting so far right that they have no room left on an 80-column terminal.
const VALUE_WIDTH = 24;

/**
 * The completion list, rendered above the input box. Values on the left, what each one does on the
 * right — the description is the whole reason this exists, because someone who remembers a skill
 * exists rarely remembers its exact name.
 *
 * Purely presentational, and source-agnostic: it renders CompletionItems and knows nothing about
 * which source produced them, which is what lets a second source reuse it unchanged.
 */
export function CompletionPopup({
  matches,
  selected,
  offset,
}: {
  matches: readonly CompletionItem[];
  // Both index into the FULL match list. InputBox owns them as one state and slides `offset` by
  // `slideWindow` so the selection stays inside the window; this component only slices.
  selected: number;
  offset: number;
}) {
  if (matches.length === 0) return null;
  const visible = matches.slice(offset, offset + COMPLETION_POPUP_ROWS);
  // Rows strictly BELOW the window, the same count `util/format.ts`'s own `remaining` gives every
  // list panel — not `matches.length - visible.length`, which counts the rows scrolled off ABOVE
  // too and so would never count down as the user arrows toward the bottom.
  const remainingCount = remaining(matches.length, offset, COMPLETION_POPUP_ROWS);
  return (
    <box flexDirection="column">
      {visible.map((item, index) => {
        const isSelected = offset + index === selected;
        // Reverse video via an explicit `theme.selectedBg`/`theme.selectedFg` pair, never
        // `TextAttributes.INVERSE` — ui/ListRow.tsx's own comment records the raw PTY capture
        // showing INVERSE setting a cell's background to its own foreground. It hit this popup
        // twice over, once per column: the value column's `theme.text` and the description
        // column's `theme.muted` each became their own background, so a selected row read as two
        // adjacent gray bands with nothing legible in either. On a selected row both columns take
        // `selectedFg`; the band itself is the emphasis, so the muted/normal split that separates
        // them on every other row has nothing left to do here.
        const fg = isSelected ? theme.selectedFg : undefined;
        const bg = isSelected ? theme.selectedBg : undefined;
        return (
          // Two sibling `<text>` nodes, never one with two children — ui/ListRow.tsx documents why a
          // single truncated `<text>` spanning more than one child renders blank on overflow. Only
          // the description shrinks; the value column holds its width so descriptions stay aligned
          // as the list filters.
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
