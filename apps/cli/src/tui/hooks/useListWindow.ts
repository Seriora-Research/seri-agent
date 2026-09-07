import type { KeyEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { APP_CHROME_ROWS, listWindowSize, remaining, slideWindow } from "../util/format";

export function useListWindow<T>(
  rows: readonly T[],
  initialSelected = 0,
): {
  selected: number;
  visible: { row: T; isSelected: boolean }[];
  remainingCount: number;
  handleArrowKey: (key: KeyEvent) => boolean;
  reset: () => void;
} {
  const { height: terminalRows } = useTerminalDimensions();
  const windowSize = listWindowSize(terminalRows - APP_CHROME_ROWS);
  const [win, setWin] = useState(() => ({
    selected: initialSelected,
    offset: slideWindow(0, initialSelected, windowSize),
  }));

  useEffect(() => {
    setWin((current) => {
      const slid = slideWindow(current.offset, current.selected, windowSize);
      const offset = Math.min(slid, Math.max(0, rows.length - windowSize));
      return offset === current.offset ? current : { ...current, offset };
    });
  }, [windowSize, rows.length]);

  return {
    selected: win.selected,
    visible: rows.slice(win.offset, win.offset + windowSize).map((row, i) => ({
      row,
      isSelected: win.offset + i === win.selected,
    })),
    remainingCount: remaining(rows.length, win.offset, windowSize),
    handleArrowKey: (key) => {
      if (key.name !== "up" && key.name !== "down") return false;
      setWin((current) => {
        const next =
          key.name === "up"
            ? current.selected - 1
            : Math.min(rows.length - 1, current.selected + 1);
        const selected = Math.max(0, next);
        return { selected, offset: slideWindow(current.offset, selected, windowSize) };
      });
      return true;
    },
    reset: () => setWin({ selected: 0, offset: 0 }),
  };
}
