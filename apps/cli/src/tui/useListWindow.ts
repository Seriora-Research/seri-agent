// Shared list-window state for every panel that renders a scrollable row list (ModelPicker,
// ConfigPanel, PermissionsPanel, SetupPanel) — owns the row array, the selection index, and the
// window offset slid by `slideWindow`'s own clamp-don't-re-center rule as the selection moves.
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
  // Each visible row paired with whether IT is the selected one — callers never see the window
  // offset or do their own `offset + localIndex` arithmetic to find out.
  visible: { row: T; isSelected: boolean }[];
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
  // `selected` and `offset` move together as one unit, in one updater: every place either changes
  // derives the other via `slideWindow`'s clamp-don't-re-center rule, so nothing can apply one
  // without the other. Two independent `useState`s used to mean `handleArrowKey` called `setOffset`
  // FROM INSIDE `setSelected`'s own updater — only safe because `slideWindow` is idempotent, and a
  // leftover of `selected`/`offset` having been split across the hook and its caller before this
  // hook owned both.
  const [win, setWin] = useState(() => ({
    selected: initialSelected,
    offset: slideWindow(0, initialSelected, windowSize),
  }));

  // A terminal resize can shrink `windowSize` with no keypress at all — `handleArrowKey` above
  // only re-slides on an explicit arrow press, so without this a shrink can leave the currently
  // selected row outside the visible window until the next arrow key happens to notice. Re-runs
  // the identical clamp-don't-re-center rule; a redundant call on an ordinary arrow press is a
  // no-op (handleArrowKey already applied the same result synchronously), so this only does real
  // work on a resize. `selected`/`offset` living in one state means this effect only needs
  // `windowSize` as a dependency — `win` itself already changed atomically wherever `selected` did.
  useEffect(() => {
    setWin((current) => ({
      selected: current.selected,
      offset: slideWindow(current.offset, current.selected, windowSize),
    }));
  }, [windowSize]);

  return {
    selected: win.selected,
    visible: rows.slice(win.offset, win.offset + windowSize).map((row, i) => ({
      row,
      isSelected: win.offset + i === win.selected,
    })),
    remainingCount: remaining(rows.length, win.offset, windowSize),
    handleArrowKey: (key) => {
      if (!key.upArrow && !key.downArrow) return false;
      setWin((current) => {
        const next = key.upArrow
          ? current.selected - 1
          : Math.min(rows.length - 1, current.selected + 1);
        // Math.max(0, ...) on the RESULT, not just the upArrow branch: rows.length === 0 makes
        // the downArrow clamp above evaluate to Math.min(-1, n) = -1, so an empty list's own
        // selection would otherwise go negative on a single Down press.
        const selected = Math.max(0, next);
        return { selected, offset: slideWindow(current.offset, selected, windowSize) };
      });
      return true;
    },
    reset: () => setWin({ selected: 0, offset: 0 }),
  };
}
