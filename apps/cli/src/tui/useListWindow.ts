// Shared list-window state for every panel that renders a scrollable row list (ModelPicker,
// ConfigPanel, PermissionsPanel, SetupPanel) — `windowSize` from `listWindowSize` (format.ts),
// `offset` slid by `slideWindow`'s own clamp-don't-re-center rule as the caller's own selection
// index moves. Component-local, not reducer state: these lists are transient and panel-scoped, and
// (unlike the transcript's scroll offset) no external event stream mutates them — the same
// distinction reducer.ts's own TuiState.transcriptScrollOffset comment draws.

import { useWindowSize } from "ink";
import { useState } from "react";
import { listWindowSize, slideWindow } from "./format";

export function useListWindow(initialSelected: number): {
  offset: number;
  windowSize: number;
  // Called by the caller's own up/down-arrow handler with the NEXT selected index, so the window
  // slides only far enough to keep it in view.
  onSelectionMove: (nextSelected: number) => void;
  // Called whenever the caller's own list is replaced or re-filtered out from under the current
  // window (ModelPicker's own filter typing) — snaps back to the top rather than leaving the
  // window offset pointing past the end of a shorter list.
  reset: () => void;
} {
  const { rows } = useWindowSize();
  const windowSize = listWindowSize(rows);
  // Seeded from `initialSelected` via the same slideWindow rule onSelectionMove uses, not a bare
  // 0: a panel can mount with a non-zero seeded selection (ConfigPanel/PermissionsPanel/SetupPanel
  // all re-dispatch their own `selected` after a save/unset/remove), and a hardcoded-0 offset would
  // scroll that row off-screen until the next arrow key on a list longer than the window.
  const [offset, setOffset] = useState(() => slideWindow(0, initialSelected, windowSize));

  return {
    offset,
    windowSize,
    onSelectionMove: (nextSelected) => {
      setOffset((current) => slideWindow(current, nextSelected, windowSize));
    },
    reset: () => setOffset(0),
  };
}
