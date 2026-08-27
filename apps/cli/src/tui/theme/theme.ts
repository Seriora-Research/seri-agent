import type { PermissionMode } from "../../gate/gate";

// The TUI's monochrome palette (docs/design/tui.md): every component imports its color from here
// rather than hardcoding a literal. `error`/`warning` carry no hue — ERROR_MARK/WARNING_MARK below
// are what distinguishes an alert from ordinary text now that color no longer does. Selection is
// reverse video, not a background color token (see ui/ListRow.tsx). ANSI-16 color names only, with
// two exceptions — `userBg` and `mode` below. Verified against @opentui/core's parseColor
// (lib/RGBA.ts): both an ANSI-16 name ("white"/"gray") and a raw hex string resolve through the
// same `fg`/`bg` props every `<text>`/`<box>` accepts, so no adapter is needed here. One real
// difference from Ink/chalk: OpenTUI resolves a named color to a fixed RGB value at parse time
// and always emits truecolor escapes, rather than chalk's real ANSI-16 SGR codes that let a
// user's own terminal theme repaint "white"/"gray" — harmless for this palette specifically,
// since every token here is already a fixed value chosen deliberately (`mode`'s own hues
// included), not one meant to track a live terminal theme, but worth knowing if a future token
// ever expected to inherit the terminal's own palette.
const MUTED = "gray";

export const theme = {
  // An explicit off-white hex, not the ANSI-16 "white" `error`/`warning` use: pure white reads as
  // eye-straining on most dark terminal themes for a color this large a share of the screen (the
  // transcript's own prose), so ordinary text gets a softer off-white instead.
  text: "#d4d4d4",
  error: "white",
  warning: "white",
  muted: MUTED,
  // A confirmed, deliberate second use of background color (docs/design/tui.md) — the user-message
  // row band, not an oversight of the "reverse-video row only" rule `selected` above follows. An
  // explicit hex value, not the ANSI-16 `"gray"` every other token here uses: plain `"gray"`
  // downsamples to a near-white on some terminals' own ANSI-16 palettes, reading as washed-out and
  // low-contrast against the white/light-gray text sitting on it — this dark-charcoal value renders
  // consistently across terminals regardless of how they resolve ANSI-16 names.
  userBg: "#333333",
  // The mode indicator's own scoped exception (docs/design/tui.md): the three `PermissionMode`
  // values get one soft hue each rather than sharing `text`/`muted` — the whole point of the
  // indicator is that the most dangerous mode must not look identical to the safest one at a
  // glance. Explicit hex for `read-only`/`auto`, for `userBg`'s own reason above (a plain `"gray"`
  // downsamples inconsistently across terminals' own ANSI-16 palettes — that's a problem for a
  // BACKGROUND, where washed-out contrast against light text is the failure mode). `approve-each`
  // is the one entry that stays `MUTED` (`"gray"` as a foreground, the same token every other muted
  // string in this file already uses without issue) rather than getting its own hex: it's seri's
  // factory default (CC's own ask-first default is gray too), so the common case adds no hue at
  // all. Typed against `PermissionMode` via `satisfies` so a fourth mode is a compile error.
  mode: {
    "read-only": "#8ab4c8",
    "approve-each": MUTED,
    auto: "#cc8a6a",
  } satisfies Record<PermissionMode, string>,
  // Inline code / code blocks (markup.raw, syntaxStyle.ts): a fourth deliberate hue exception.
  // `muted` ("gray") reads as near-black on most dark terminal themes — too close to the
  // background to read as "marked" text at all. A soft light blue instead, distinct from the
  // mode indicator's own hues, so code the model emits stands out from prose without competing
  // with `mode`'s danger signal.
  code: "#9fc5e8",
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
