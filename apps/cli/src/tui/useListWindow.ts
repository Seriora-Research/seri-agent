// Shared list-window state for every panel that renders a scrollable row list (ModelPicker,
// ConfigPanel, PermissionsPanel, SetupPanel) — owns the row array, the selection index, and the
// window `offset` slid by `slideWindow`'s own clamp-don't-re-center rule as the selection moves.
// Component-local, not reducer state: these lists are transient and panel-scoped, and (unlike the
// transcript's scroll offset) no external event stream mutates them — the same distinction
// reducer.ts's own TuiState.transcriptScrollOffset comment draws.

import { useWindowSize } from "ink";
import type { Key } from "ink";
import { useEffect, useState } from "react";
import { APP_CHROME_ROWS, listWindowSize, remaining, slideWindow } from "./format";

export function useListWindow<T>(
  rows: readonly T[],
  initialSelected = 0,
): {
  selected: number;
  offset: number;
  windowSize: number;
  visible: T[];
  remainingCount: number;
  // Returns true when the key was an arrow it handled, so the caller's own useInput can
  // `if (handleArrowKey(key)) return;` in the same position its inline arrow blocks used to sit.
  handleArrowKey: (key: Key) => boolean;
  // Called whenever the caller's own list is replaced or re-filtered out from under the current
  // selection and window (ModelPicker's own filter typing) — snaps both back to the top rather
  // than leaving the selection/window offset pointing past the end of a shorter list.
  reset: () => void;
} {
  const { rows: terminalRows } = useWindowSize();
  // `terminalRows - APP_CHROME_ROWS`, not raw `terminalRows`: a panel replaces InputBox in
  // App.tsx's own render ternary, but everything else App.tsx can render alongside a panel — the
  // root Box's own spare row, the unconditional mode-indicator row, a `commandError` line,
  // AuthBanner's three-row bordered Box — still needs its own share of `terminalRows`. See
  // APP_CHROME_ROWS' own comment (format.ts) for why that reservation is unconditional rather than
  // threaded through as props.
  const windowSize = listWindowSize(terminalRows - APP_CHROME_ROWS);
  const [selected, setSelected] = useState(initialSelected);
  // Seeded from `initialSelected` via the same slideWindow rule handleArrowKey uses, not a bare 0:
  // a panel can mount with a non-zero seeded selection (ConfigPanel/PermissionsPanel/SetupPanel all
  // re-dispatch their own `selected` after a save/unset/remove), and a hardcoded-0 offset would
  // scroll that row off-screen until the next arrow key on a list longer than the window.
  const [offset, setOffset] = useState(() => slideWindow(0, initialSelected, windowSize));

  // A terminal resize can shrink `windowSize` with no keypress at all — `handleArrowKey` above
  // only re-slides on an explicit arrow press, so without this a shrink can leave the currently
  // selected row outside the visible window until the next arrow key happens to
  // notice. Re-runs the identical clamp-don't-re-center rule, keyed on `windowSize` (`selected`
  // too, since it can also change between renders) — a redundant call on an ordinary arrow press
  // is a no-op (handleArrowKey already applied the same result synchronously), so this only does
  // real work on a resize.
  useEffect(() => {
    setOffset((current) => slideWindow(current, selected, windowSize));
  }, [selected, windowSize]);

  return {
    selected,
    offset,
    windowSize,
    visible: rows.slice(offset, offset + windowSize),
    remainingCount: remaining(rows.length, offset, windowSize),
    handleArrowKey: (key) => {
      if (!key.upArrow && !key.downArrow) return false;
      setSelected((current) => {
        const next = key.upArrow
          ? Math.max(0, current - 1)
          : Math.min(rows.length - 1, current + 1);
        setOffset((currentOffset) => slideWindow(currentOffset, next, windowSize));
        return next;
      });
      return true;
    },
    reset: () => {
      setSelected(0);
      setOffset(0);
    },
  };
}
