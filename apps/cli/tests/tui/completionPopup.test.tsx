/** @jsxImportSource @opentui/react */
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { COMPLETION_POPUP_ROWS, CompletionPopup } from "../../src/tui/components/CompletionPopup";
import { theme } from "../../src/tui/theme/theme";
import type { CompletionItem } from "../../src/tui/util/completion";

// CompletionPopup has no hooks, so calling it directly (not mounting it) is safe: its return value
// is a plain element tree whose props are exactly what it would render. That matters here because
// both bugs this file pins are invisible to `captureCharFrame()`, which carries no color info.
type Row = ReactElement<{
  backgroundColor: string | undefined;
  children: ReactElement<{ fg: string; bg: string | undefined; children: string }>[];
}>;

function rows(matches: readonly CompletionItem[], selected: number, offset: number): Row[] {
  const tree = CompletionPopup({ matches, selected, offset }) as ReactElement<{
    children: [Row[], unknown];
  }>;
  return tree.props.children[0];
}

function footer(matches: readonly CompletionItem[], selected: number, offset: number) {
  const tree = CompletionPopup({ matches, selected, offset }) as ReactElement<{
    children: [unknown, ReactElement<{ children: (string | number)[] }> | false];
  }>;
  const line = tree.props.children[1];
  return line === false ? undefined : line.props.children.join("");
}

const items: CompletionItem[] = Array.from({ length: 26 }, (_, i) => ({
  value: `/cmd${i}`,
  description: `does thing ${i}`,
}));

describe("CompletionPopup", () => {
  // The scroll regression: the popup used to render `matches.slice(0, COMPLETION_POPUP_ROWS)` and
  // InputBox used to clamp the selection to that same slice, so a 26-command list stopped dead on
  // its sixth row and the 21 commands below it could not be reached by arrowing at all.
  test("the window slides with the offset, so a match below the sixth row is reachable", () => {
    const visible = rows(items, 8, 3);

    expect(visible).toHaveLength(COMPLETION_POPUP_ROWS);
    expect(visible[0]?.props.children[0]?.props.children.trim()).toBe("/cmd3");
    expect(visible.at(-1)?.props.children[0]?.props.children.trim()).toBe("/cmd8");
  });

  test("exactly the row at `selected` is highlighted, counted against the full list not the slice", () => {
    const highlighted = rows(items, 8, 3).map((row) => row.props.backgroundColor !== undefined);

    expect(highlighted).toEqual([false, false, false, false, false, true]);
  });

  // `remaining` counts rows strictly BELOW the window. Before the fix the footer was derived from
  // `matches.length - visible.length`, which is flat at 20 forever: it never counted down as the
  // user scrolled, so the list looked stuck even where the selection did move.
  test("the footer counts down as the window scrolls toward the bottom", () => {
    expect(footer(items, 0, 0)).toBe("+20 more — keep typing to narrow");
    expect(footer(items, 8, 3)).toBe("+17 more — keep typing to narrow");
    expect(footer(items, 25, 20)).toBeUndefined();
  });

  // The invisible-text regression: both columns used to carry `TextAttributes.INVERSE` and their
  // own `fg`, and OpenTUI 0.5.6 renders INVERSE by emitting a background equal to the foreground.
  // Because the two columns set DIFFERENT foregrounds, a selected row painted two adjacent gray
  // bands, each with its own text invisible inside it. Both halves matter, so both are asserted:
  // one background for the whole row, and a foreground that differs from it in every column.
  test("a selected row is one background with a foreground that differs from it in every column", () => {
    const row = rows(items, 2, 0)[2];

    expect(row?.props.backgroundColor).toBe(theme.selectedBg);
    const backgrounds = new Set(row?.props.children.map((cell) => cell.props.bg));
    expect(backgrounds).toEqual(new Set([theme.selectedBg]));
    for (const cell of row?.props.children ?? []) {
      expect(cell.props.fg).toBe(theme.selectedFg);
      expect(cell.props.fg).not.toBe(cell.props.bg);
    }
  });

  test("an unselected row keeps the value/description split that makes the list scannable", () => {
    const [value, description] = rows(items, 2, 0)[0]?.props.children ?? [];

    expect(value?.props.fg).toBe(theme.text);
    expect(description?.props.fg).toBe(theme.muted);
    expect(value?.props.bg).toBeUndefined();
    expect(description?.props.bg).toBeUndefined();
  });
});
