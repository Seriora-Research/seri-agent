// Shared list-window state for every panel that renders a scrollable row list (ModelPicker,
// ConfigPanel, PermissionsPanel, SetupPanel) — `windowSize` from `listWindowSize` (format.ts),
// `offset` slid by `slideWindow`'s own clamp-don't-re-center rule as the caller's own selection
// index moves. Component-local, not reducer state: these lists are transient and panel-scoped, and
// (unlike the transcript's scroll offset) no external event stream mutates them — the same
// distinction reducer.ts's own TuiState.transcriptScrollOffset comment draws.

import { useWindowSize } from "ink";
import { useEffect, useState } from "react";
import { APP_CHROME_ROWS, listWindowSize, slideWindow } from "./format";

export function useListWindow(selected: number): {
  offset: number;
  windowSize: number;
  // Called by the caller's own up/down-arrow handler with the NEXT selected index, so the window
  // slides only far enough to keep it in view. Kept as an explicit call — not folded into the
  // effect below — so a keypress updates `offset` in the SAME render as `selected` itself, rather
  // than one render later once the effect below runs after commit (a visible one-frame lag on
  // every arrow press).
  onSelectionMove: (nextSelected: number) => void;
  // Called whenever the caller's own list is replaced or re-filtered out from under the current
  // window (ModelPicker's own filter typing) — snaps back to the top rather than leaving the
  // window offset pointing past the end of a shorter list.
  reset: () => void;
} {
  const { rows } = useWindowSize();
  // `rows - APP_CHROME_ROWS`, not raw `rows`: a panel replaces InputBox in App.tsx's own render
  // ternary, but everything else App.tsx can render alongside a panel — the root Box's own spare
  // row, the unconditional mode-indicator row, a `commandError` line, AuthBanner's three-row
  // bordered Box — still needs its own share of `rows`. See APP_CHROME_ROWS' own comment
  // (format.ts) for why that reservation is unconditional rather than threaded through as props.
  const windowSize = listWindowSize(rows - APP_CHROME_ROWS);
  // Seeded from `selected` via the same slideWindow rule onSelectionMove uses, not a bare 0: a
  // panel can mount with a non-zero seeded selection (ConfigPanel/PermissionsPanel/SetupPanel all
  // re-dispatch their own `selected` after a save/unset/remove), and a hardcoded-0 offset would
  // scroll that row off-screen until the next arrow key on a list longer than the window.
  const [offset, setOffset] = useState(() => slideWindow(0, selected, windowSize));

  // A terminal resize can shrink `windowSize` with no keypress at all — `onSelectionMove` above
  // only re-slides on an explicit arrow press, so without this a shrink can leave the currently
  // selected row outside `[offset, offset + windowSize)` until the next arrow key happens to
  // notice. Re-runs the identical clamp-don't-re-center rule, keyed on `windowSize` (`selected`
  // too, since it can also change between renders) — a redundant call on an ordinary arrow press
  // is a no-op (onSelectionMove already applied the same result synchronously), so this only
  // does real work on a resize.
  useEffect(() => {
    setOffset((current) => slideWindow(current, selected, windowSize));
  }, [selected, windowSize]);

  return {
    offset,
    windowSize,
    onSelectionMove: (nextSelected) => {
      setOffset((current) => slideWindow(current, nextSelected, windowSize));
    },
    reset: () => setOffset(0),
  };
}
