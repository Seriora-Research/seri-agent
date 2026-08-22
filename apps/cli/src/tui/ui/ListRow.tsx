/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";

// The selection marker + row highlight shared by every selectable-list panel. `truncate` applies
// unconditionally, not per caller: every `useListWindow`-backed panel budgets exactly one row per
// list row (PANEL_CHROME_ROWS, util/format.ts), and OpenTUI's default wrapping would soft-wrap an
// over-width label into a second row and overflow that budget. `WelcomeSplash` is the one caller
// not windowed by `useListWindow` at all (2-3 fixed items, no scroll) — for it, this is a
// deliberate, tested behavior change from its pre-ListRow rows, which soft-wrapped instead of
// truncating (see the splash's own truncation test).
//
// Selection is reverse video, not color (Design conformance, docs/design/tui.md): a single
// `TextAttributes.INVERSE` swaps this row's own foreground/background at render time, replacing
// Ink/chalk's `backgroundColor={theme.selected}` + `inverse` combo — that combo existed only
// because Ink's plain `backgroundColor` painted default-foreground text on ANSI black, which reads
// as invisible on many dark terminal themes, and `inverse` was the second prop needed to fix it.
// OpenTUI's own INVERSE attribute already does the full swap in one step, so `theme.selected` is
// not read here at all.
export function ListRow({ selected, label }: { selected: boolean; label: string }) {
  return (
    <text attributes={selected ? TextAttributes.INVERSE : TextAttributes.NONE} truncate>
      {selected ? "> " : "  "}
      {label}
    </text>
  );
}
