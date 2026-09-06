/** @jsxImportSource @opentui/react */
import { theme } from "../theme/theme";

// The selection marker + row highlight shared by every selectable-list panel. `truncate` applies
// unconditionally, not per caller: every `useListWindow`-backed panel budgets exactly one row per
// list row (PANEL_CHROME_ROWS, util/format.ts), and OpenTUI's default wrapping would soft-wrap an
// over-width label into a second row and overflow that budget. `WelcomeSplash` is the one caller
// not windowed by `useListWindow` at all (2-3 fixed items, no scroll) — for it, this is a
// deliberate, tested behavior change from its pre-ListRow rows, which soft-wrapped instead of
// truncating (see the splash's own truncation test).
//
// Selection is accent fill with on-ink text, spelled as an explicit `theme.selectedBg` +
// `theme.selectedFg` pair rather than `TextAttributes.INVERSE`. INVERSE cannot express it on
// OpenTUI 0.5.6: a raw PTY capture of this very row shows it emitting `38;2;255;255;255`
// `48;2;255;255;255` `7`, i.e. a background set to the SAME value as the foreground, so the row
// painted a solid block with `> Log in` invisible inside it. Naming both colors is also what lets
// the highlight sit on the wrapping `<box>`, which spans the full row width — a background painted
// only under the glyphs left a ragged right edge whose width moved with each label. Carets in
// InputBox, ModelPicker, and SkillsPanel use the same explicit pair (`theme.accent` /
// `theme.onInk`) for the same reason: INVERSE would paint fg=bg, and the caret has to be amber.
//
// The marker ("> "/"  ") and `label` are two SIBLING `<text>` nodes, not one `<text>` with two
// children — verified live (apps/cli/tests/tui/): a single `<text truncate>` whose content spans
// more than one child (two adjacent string expressions, as `{marker}{label}` used to produce)
// renders as a BLANK line the instant that content overflows the available width, on every
// terminal width tested, both selected and unselected. Splitting the marker into its own
// untruncated sibling and truncating only `label` avoids the bug entirely and is the one thing
// this row must never lose regardless of how little space is left, mirroring the cursor-reservation
// pattern `components/ModelPicker.tsx`'s own filter row uses.
//
// `flexShrink={0}` on the marker and `wrapMode="none"` on the label are both required for
// `truncate` to actually clip instead of soft-wrap — verified live: without `wrapMode="none"`,
// `truncate` has nothing to do because the row's default word-wrap already "fits" the label by
// spilling it onto a second line, so a long label wraps across two rows instead of clipping to
// one; without `flexShrink={0}`, the row's flex layout shrinks the marker along with the label
// once both no longer fit, dropping the marker's own trailing space.
export function ListRow({ selected, label }: { selected: boolean; label: string }) {
  const fg = selected ? theme.selectedFg : undefined;
  return (
    <box flexDirection="row" backgroundColor={selected ? theme.selectedBg : undefined}>
      <text fg={fg} bg={selected ? theme.selectedBg : undefined} flexShrink={0}>
        {selected ? "> " : "  "}
      </text>
      <text
        fg={fg}
        bg={selected ? theme.selectedBg : undefined}
        truncate
        wrapMode="none"
        flexGrow={1}
      >
        {label}
      </text>
    </box>
  );
}
