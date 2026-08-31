/** @jsxImportSource @opentui/react */
// Messages typed while a turn was already running (state/reducer.ts's `MessageQueue`), drawn
// between the transcript and the input box. A queued message has already left the user's hands as
// far as the input box is concerned, so it belongs on that side of it; the input box stays the
// floor of the screen, the one row that is always theirs.
//
// Nothing renders at depth zero — not an empty frame, not a header. The block only costs rows when
// there is something in it, which matters because every row here comes out of the transcript's own
// (app.tsx's transcript box is `flexGrow`, so rows added below it shrink the scrollbox).
import { useKeyboard } from "@opentui/react";
import type { Dispatch, MessageQueue } from "../state/reducer";
import { theme } from "../theme/theme";
import { remaining, singleLine } from "../util/format";
import { InputBox } from "./InputBox";

// How many rows the block may paint at once. One under CompletionPopup's own budget, which sits in
// the same place and states the same reason: it pushes the transcript up by this much in the worst
// case, and a user reaches a queued row by pressing an arrow far faster than they miss the two
// transcript lines it costs.
export const QUEUE_WINDOW = 5;

// How far the selection may sit from the top of the window before it slides — the same
// stateless clamp `childWindowOffset` (SubagentPanel.tsx) uses, derived from QUEUE_WINDOW rather
// than written as a second literal, so changing the row budget cannot leave the two disagreeing.
const QUEUE_WINDOW_LEAD = QUEUE_WINDOW - 3;

export const QUEUE_KEY_HINT = "ctrl+↑/↓ select · ctrl+e edit · ctrl+x drop";

// Stateless, so there is no window offset to keep in sync with a selection that moves from the
// reducer. Exported for its own test: this is the only arithmetic in the file, and the alternative
// to testing it directly is asserting on a captured frame with six rows in it.
export function queueWindowOffset(selected: number, total: number): number {
  const maxOffset = Math.max(0, total - QUEUE_WINDOW);
  return Math.min(Math.max(selected - QUEUE_WINDOW_LEAD, 0), maxOffset);
}

export function QueueBlock({
  queue,
  width,
  noPanelOpen,
  onSubmit,
  dispatch,
}: {
  queue: MessageQueue;
  width: number;
  // Whether this block's keys are live. Gates the handler below, and also the header's key legend:
  // a legend that names keys the user's keypress will not reach is worse than no legend, and while
  // a panel or an ApprovalBox owns the screen these keys do nothing.
  noPanelOpen: boolean;
  // App's own onSubmit. cli.ts routes a submission made while `queue.editing` to the edit-commit
  // branch, so the row editor needs no separate commit channel.
  onSubmit: (value: string) => void;
  dispatch: Dispatch;
}) {
  const { items, selected, editing } = queue;

  useKeyboard((key) => {
    if (!noPanelOpen || items.length === 0 || !key.ctrl) return;
    // Ctrl+P/Ctrl+N alongside the arrows, and not as decoration. A terminal that strips the arrow
    // modifier — macOS Terminal.app by default, tmux without `xterm-keys on`, the Linux VT —
    // delivers Ctrl+↓ as a PLAIN Down, which InputBox reads as its own empty-Down and uses to hand
    // focus to the subagent roster. So the arrows do not merely fail there, they do something
    // visibly wrong, and the fallback has to be a chord that survives: Ctrl+P/N are single bytes
    // (0x10/0x0e) and arrive identically on every terminal on every platform.
    if (key.name === "up" || key.name === "p") {
      dispatch({ type: "queue-selection-moved", delta: -1 });
      return;
    }
    if (key.name === "down" || key.name === "n") {
      dispatch({ type: "queue-selection-moved", delta: 1 });
      return;
    }
    if (key.name === "e") {
      dispatch({ type: "queue-edit-started" });
      return;
    }
    // Ctrl+X, not the Ctrl+D the issue's own simulation proposed. Ctrl-D is spoken for: AGENTS.md
    // names it as a graceful exit at the input box, and specs/038-tui-command-registry decided that
    // InputBox and ApprovalBox keep their own quit() calls. Claiming it here would reverse both
    // silently, and would leave one key quitting inside an approval prompt and dropping a row
    // outside it a second later. Ctrl+X is unclaimed and reads as "cut".
    if (key.name === "x") {
      dispatch({ type: "queue-item-dropped" });
    }
  });

  if (items.length === 0) return null;

  const offset = queueWindowOffset(selected, items.length);
  const visible = items.slice(offset, offset + QUEUE_WINDOW);
  const overflow = remaining(items.length, offset, QUEUE_WINDOW);
  const depthLabel = `${items.length} queued`;
  // The same rule the mode row applies to its own right-hand side (app.tsx's `showRightSide`): when
  // both halves of a `space-between` row do not fit, the hint loses rather than the row wrapping.
  // A wrapped row costs a terminal row this block did not budget for, inside a tree App pins to
  // `height={rows}`.
  const showHint = noPanelOpen && width >= depthLabel.length + QUEUE_KEY_HINT.length + 2;

  return (
    <box flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.muted}>{depthLabel}</text>
        {showHint && <text fg={theme.muted}>{QUEUE_KEY_HINT}</text>}
      </box>
      {visible.map((item, index) => (
        <QueueRow
          // The row's own id, not its index: an index key would make the row under the mounted
          // editor a different element the moment a row above it was dropped, remounting the
          // editor and taking the half-typed text with it.
          key={item.id}
          ordinal={offset + index + 1}
          text={item.text}
          selected={offset + index === selected}
          editing={editing && offset + index === selected}
          noPanelOpen={noPanelOpen}
          onSubmit={onSubmit}
          dispatch={dispatch}
        />
      ))}
      {overflow > 0 && <text fg={theme.muted}>{`  +${overflow}`}</text>}
    </box>
  );
}

// Deliberately not ui/ListRow.tsx, which paints one foreground across the whole row: an unselected
// queue row's ordinal is muted while its text is not, and that is the distinction that makes a
// column of numbers read as a gutter rather than as part of the message.
//
// It does keep every structural constraint ListRow's own comment records, because those were
// verified live and none of them is about color. The ordinal and the body are SIBLING <text> nodes,
// never one truncating <text> with two children, which renders a BLANK line the instant it
// overflows. The ordinal carries `flexShrink={0}` so the row's flex layout cannot shrink it away
// with the body, and the body carries `wrapMode="none"` so `truncate` clips instead of soft-wrapping
// onto a second row this block has not budgeted.
function QueueRow({
  ordinal,
  text,
  selected,
  editing,
  noPanelOpen,
  onSubmit,
  dispatch,
}: {
  ordinal: number;
  text: string;
  selected: boolean;
  editing: boolean;
  noPanelOpen: boolean;
  onSubmit: (value: string) => void;
  dispatch: Dispatch;
}) {
  const fg = selected ? theme.selectedFg : undefined;
  const bg = selected ? theme.selectedBg : undefined;
  return (
    <box flexDirection="row" backgroundColor={bg}>
      <text fg={editing ? undefined : (fg ?? theme.muted)} bg={bg} flexShrink={0}>
        {`${ordinal}  `}
      </text>
      {editing ? (
        <InputBox
          // `prefill` is read once, as this mount's own starting value, which is the only thing it
          // supports — and it is enough here because this component only exists while `editing`, so
          // every Ctrl+E is a fresh mount. Reusing InputBox rather than hand-rolling a second editor
          // is what gets paste, the keystroke throttle and the block cursor for nothing.
          prefill={text}
          bare
          // Renders ABOVE App's panel ternary, unlike every other input surface, so it stays mounted
          // when an ApprovalBox replaces the main box. Without this the "y" that answers a mid-edit
          // approval would ALSO be typed into the queued message. `inert` rather than unmounting,
          // because unmounting would take the half-typed edit with it.
          inert={!noPanelOpen}
          onSubmit={onSubmit}
          onEscape={() => dispatch({ type: "queue-edit-cancelled" })}
        />
      ) : (
        <text fg={fg} bg={bg} truncate wrapMode="none" flexGrow={1}>
          {singleLine(text)}
        </text>
      )}
    </box>
  );
}
