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
// The marker ("> "/"  ") and `label` are two SIBLING `<text>` nodes, not one `<text>` with two
// children — verified live (apps/cli/tests/tui/): a single `<text truncate>` whose content spans
// more than one child (two adjacent string expressions, as `{marker}{label}` used to produce)
// renders as a BLANK line the instant that content overflows the available width, on every
// terminal width tested, both selected and unselected. Splitting the marker into its own
// untruncated sibling and truncating only `label` avoids the bug entirely and is the one thing
// this row must never lose regardless of how little space is left, mirroring the cursor-reservation
// pattern `components/ModelPicker.tsx`'s own filter row uses.
export function ListRow({ selected, label }: { selected: boolean; label: string }) {
  const attributes = selected ? TextAttributes.INVERSE : TextAttributes.NONE;
  return (
    <box flexDirection="row">
      <text attributes={attributes}>{selected ? "> " : "  "}</text>
      <text attributes={attributes} truncate>
        {label}
      </text>
    </box>
  );
}
