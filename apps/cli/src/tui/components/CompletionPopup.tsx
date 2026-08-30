/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { theme } from "../theme/theme";
import type { CompletionItem } from "../util/completion";
import { truncatePad } from "../util/format";

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
}: {
  matches: readonly CompletionItem[];
  selected: number;
}) {
  if (matches.length === 0) return null;
  const visible = matches.slice(0, COMPLETION_POPUP_ROWS);
  const remaining = matches.length - visible.length;
  return (
    <box flexDirection="column">
      {visible.map((item, index) => {
        const attributes = index === selected ? TextAttributes.INVERSE : TextAttributes.NONE;
        return (
          // Two sibling `<text>` nodes, never one with two children — ui/ListRow.tsx documents why a
          // single truncated `<text>` spanning more than one child renders blank on overflow. Only
          // the description shrinks; the value column holds its width so descriptions stay aligned
          // as the list filters.
          <box key={item.value} flexDirection="row">
            <text attributes={attributes} fg={theme.text} flexShrink={0}>
              {truncatePad(item.value, VALUE_WIDTH)}
            </text>
            <text attributes={attributes} fg={theme.muted} truncate wrapMode="none">
              {item.description}
            </text>
          </box>
        );
      })}
      {remaining > 0 && <text fg={theme.muted}>+{remaining} more — keep typing to narrow</text>}
    </box>
  );
}
