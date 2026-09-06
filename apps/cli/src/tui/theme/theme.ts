import type { PermissionMode } from "../../gate/gate";

// The TUI's palette registry: every component imports its color from here rather than hardcoding
// a literal. `error`/`warning` carry no hue — ERROR_MARK/WARNING_MARK below are what distinguishes
// an alert from ordinary text now that color no longer does. Selection is accent fill with on-ink
// text, spelled as the `selectedBg`/`selectedFg` pair below (see ui/ListRow.tsx).
// Explicit hex everywhere except `error`/`warning`, the two ANSI-16 names left: an ANSI-16 name
// cannot express any of these values. Verified against @opentui/core's parseColor
// (lib/RGBA.ts): both an ANSI-16 name ("white"/"gray") and a raw hex string resolve through the
// same `fg`/`bg` props every `<text>`/`<box>` accepts, so no adapter is needed here. One real
// difference from Ink/chalk: OpenTUI resolves a named color to a fixed RGB value at parse time
// and always emits truecolor escapes, rather than chalk's real ANSI-16 SGR codes that let a
// user's own terminal theme repaint "white"/"gray" — harmless for this palette specifically,
// since every token here is already a fixed value chosen deliberately (`mode`'s own hues
// included), not one meant to track a live terminal theme, but worth knowing if a future token
// ever expected to inherit the terminal's own palette.
// Tool lines, the mode label, panel hints, the done marker. Ink at 58% over the default ground
// rather than the ANSI-16 "gray" it once was, which resolves to #808080 — and OpenTUI emits
// truecolor for a name anyway (see the header).
const MUTED = "#8F8D85";
const INK = "#e8e4d8";
const ACCENT = "#e8b86d";
const ON_INK = "#0c0c0b";

export const theme = {
  // An explicit off-white hex, not the ANSI-16 "white" `error`/`warning` use: pure white reads as
  // eye-straining on most dark terminal themes for a color this large a share of the screen (the
  // transcript's own prose), so ordinary text gets a softer off-white instead.
  text: INK,
  error: "white",
  warning: "white",
  muted: MUTED,
  // A confirmed, deliberate second use of background color (docs/design/tui.md) — the user-message
  // row band, not an oversight of the selected-row pair above. The ANSI-16 `"gray"` this once was
  // downsamples to a near-white on some terminals' own palettes, reading as washed-out and
  // low-contrast against the white/light-gray text sitting on it — this dark-charcoal value
  // renders consistently across terminals regardless of how they resolve ANSI-16 names.
  userBg: "#3E3E3A",
  // The selected row of every list (ui/ListRow.tsx, components/CompletionPopup.tsx): accent fill
  // with on-ink text. Two explicit colors rather than `TextAttributes.INVERSE`, which cannot
  // express it on OpenTUI 0.5.6: verified from a raw PTY capture, INVERSE emits `48;2;<fg>`
  // alongside `7`, so the cell's background lands on the SAME value as its foreground and the row
  // renders as a solid block with its text invisible inside it — one gray band per `fg` the row
  // happened to set.
  selectedBg: ACCENT,
  selectedFg: ON_INK,
  accent: ACCENT,
  onInk: ON_INK,
  // The mode indicator's own scoped exception (docs/design/tui.md): the three `PermissionMode`
  // values get one soft hue each rather than sharing `text`/`muted` — the whole point of the
  // indicator is that the most dangerous mode must not look identical to the safest one at a
  // glance. `approve-each` is the one entry that reuses `MUTED` rather than taking a hue of its
  // own: it's seri's factory default (CC's own ask-first default is gray too), so the common case
  // adds no hue at all. Typed against `PermissionMode` via `satisfies` so a fourth mode is a
  // compile error.
  mode: {
    "read-only": "#8ab4c8",
    "approve-each": MUTED,
    auto: "#cc8a6a",
  } satisfies Record<PermissionMode, string>,
  // Inline code / code blocks (markup.raw, syntaxStyle.ts): a deliberate hue exception.
  // `muted` reads as near-black on most dark terminal themes — too close to the
  // background to read as "marked" text at all. A soft light blue instead, distinct from the
  // mode indicator's own hues, so code the model emits stands out from prose without competing
  // with `mode`'s danger signal.
  code: "#9fc5e8",
  quotaExhausted: "#e05050",
  diffAdd: "#3fb950",
  diffDel: "#f85149",
  // Every bordered surface's own rule (theme/spacing.ts's FRAME). Same ink as prose, so the
  // frame reads as structure rather than a second hue.
  border: INK,
} as const;

// Prefixed onto an alert addressed to the user (a failure or a question) at the TUI call site —
// never inside a shared formatter like approvalPromptText, which the non-interactive CLI path also
// calls and must not have this mark applied to.
export const ERROR_MARK = "✕ ";
export const WARNING_MARK = "! ";
// Secondary-detail glyph, not a color — the same "weight and a mark, not color" convention
// ERROR_MARK/WARNING_MARK already use. Prefixed onto a tool-activity anomaly or grep/glob
// match path at the TUI call site.
export const TREE_BRANCH = "└ ";
// Secondary-detail glyph, not a color — same convention as TREE_BRANCH. A tool-activity group
// with more than one sub-line prefixes every child but the last with this and the last with
// TREE_BRANCH, so the tree reads as a tree instead of a stack of identical branches.
export const TREE_MID = "├ ";
// Secondary-detail glyph, not a color — same convention as TREE_BRANCH. Prefixed onto the
// archivist stats line inside archivistLine (shared CLI+TUI formatter), unlike WARNING_MARK
// which stays TUI-call-site-only.
export const ARCHIVIST_MARK = "· ";
