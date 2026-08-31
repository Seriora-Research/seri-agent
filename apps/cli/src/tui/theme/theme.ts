import type { PermissionMode } from "../../gate/gate";

// The TUI's monochrome palette (docs/design/tui.md): every component imports its color from here
// rather than hardcoding a literal. `error`/`warning` carry no hue — ERROR_MARK/WARNING_MARK below
// are what distinguishes an alert from ordinary text now that color no longer does. Selection is
// reverse video, spelled as the `selectedBg`/`selectedFg` pair below (see ui/ListRow.tsx).
// Explicit hex everywhere except `error`/`warning`, the two ANSI-16 names left: the reference mock
// (how_tui_should_be_uxui.png) names five exact values and an ANSI-16 name cannot express any of
// them. Verified against @opentui/core's parseColor
// (lib/RGBA.ts): both an ANSI-16 name ("white"/"gray") and a raw hex string resolve through the
// same `fg`/`bg` props every `<text>`/`<box>` accepts, so no adapter is needed here. One real
// difference from Ink/chalk: OpenTUI resolves a named color to a fixed RGB value at parse time
// and always emits truecolor escapes, rather than chalk's real ANSI-16 SGR codes that let a
// user's own terminal theme repaint "white"/"gray" — harmless for this palette specifically,
// since every token here is already a fixed value chosen deliberately (`mode`'s own hues
// included), not one meant to track a live terminal theme, but worth knowing if a future token
// ever expected to inherit the terminal's own palette.
// Sampled off the reference mock, where it is the one diluted tone: tool lines, the mode label,
// panel hints, the done marker. The ANSI-16 "gray" it replaces resolves to #808080, a half-step
// darker, and OpenTUI emits truecolor for a name anyway (see the header) — so the name bought
// nothing a terminal theme could repaint and cost the mock's own value.
const MUTED = "#8A8A8A";
// Ordinary prose's own off-white, named so `selectedBg` below can state in one place that a
// selected row is literally the color ordinary text is.
const TEXT = "#d4d4d4";

export const theme = {
  // An explicit off-white hex, not the ANSI-16 "white" `error`/`warning` use: pure white reads as
  // eye-straining on most dark terminal themes for a color this large a share of the screen (the
  // transcript's own prose), so ordinary text gets a softer off-white instead.
  text: TEXT,
  error: "white",
  warning: "white",
  muted: MUTED,
  // A confirmed, deliberate second use of background color (docs/design/tui.md) — the user-message
  // row band, not an oversight of the "reverse-video row only" rule `selected` above follows. The
  // ANSI-16 `"gray"` this once was downsamples to a near-white on some terminals' own palettes,
  // reading as washed-out and low-contrast against the white/light-gray text sitting on it — this
  // dark-charcoal value renders consistently across terminals regardless of how they resolve
  // ANSI-16 names.
  userBg: "#333333",
  // The selected row of every list (ui/ListRow.tsx, components/CompletionPopup.tsx): ink and paper
  // swapped, exactly what docs/design/tui.md means by "selection is reverse video, not color".
  // Two explicit colors rather than `TextAttributes.INVERSE`, which cannot express it on OpenTUI
  // 0.5.6: verified from a raw PTY capture, INVERSE emits `48;2;<fg>` alongside `7`, so the cell's
  // background lands on the SAME value as its foreground and the row renders as a solid block with
  // its text invisible inside it — one gray band per `fg` the row happened to set. `selectedBg` is
  // `TEXT` itself so the band is the color prose already is; `selectedFg` is tokens.md's own
  // `--ink`, the near-black the whole design system is anchored on. No hue either way, so the
  // monochrome rule holds.
  selectedBg: TEXT,
  selectedFg: "#141413",
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
  // Inline code / code blocks (markup.raw, syntaxStyle.ts): a fourth deliberate hue exception.
  // `muted` reads as near-black on most dark terminal themes — too close to the
  // background to read as "marked" text at all. A soft light blue instead, distinct from the
  // mode indicator's own hues, so code the model emits stands out from prose without competing
  // with `mode`'s danger signal.
  code: "#9fc5e8",
  // Every bordered surface's own rule (theme/spacing.ts's FRAME). Its own token rather than
  // `muted`, which it used to share: the mock draws the frame a full step darker than the text
  // sitting inside it, so one value cannot be both without the border competing with the prose.
  border: "#4A463B",
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
