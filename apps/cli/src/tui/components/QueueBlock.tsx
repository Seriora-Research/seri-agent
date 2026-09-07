/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import type { Dispatch, MessageQueue } from "../state/reducer";
import { theme } from "../theme/theme";
import { remaining, singleLine } from "../util/format";
import { InputBox } from "./InputBox";

export const QUEUE_WINDOW = 5;

const QUEUE_WINDOW_LEAD = QUEUE_WINDOW - 3;

export const QUEUE_KEY_HINT = "ctrl+↑/↓ select · ctrl+e edit · ctrl+x drop";

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
  noPanelOpen: boolean;
  onSubmit: (value: string) => void;
  dispatch: Dispatch;
}) {
  const { items, selected, editing } = queue;

  useKeyboard((key) => {
    if (!noPanelOpen || items.length === 0 || !key.ctrl) return;
    // macOS Terminal.app, tmux without xterm-keys, and the Linux VT strip the Ctrl+arrow modifier and deliver a plain Down. Ctrl+P/N are single bytes and survive.
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
    // Ctrl+D is already quit in InputBox and ApprovalBox; this binding is Ctrl+X.
    if (key.name === "x") {
      dispatch({ type: "queue-item-dropped" });
    }
  });

  if (items.length === 0) return null;

  const offset = queueWindowOffset(selected, items.length);
  const visible = items.slice(offset, offset + QUEUE_WINDOW);
  const overflow = remaining(items.length, offset, QUEUE_WINDOW);
  const depthLabel = `${items.length} queued`;
  const showHint = noPanelOpen && width >= depthLabel.length + QUEUE_KEY_HINT.length + 2;

  return (
    <box flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.muted}>{depthLabel}</text>
        {showHint && <text fg={theme.muted}>{QUEUE_KEY_HINT}</text>}
      </box>
      {visible.map((item, index) => (
        <QueueRow
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

// Ordinal and body are sibling text nodes because a truncated text with two children renders blank on overflow. flexShrink 0 on the ordinal and wrapMode none on the body match ListRow's OpenTUI constraints.
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
          prefill={text}
          bare
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
