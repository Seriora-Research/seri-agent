// The TUI's monochrome palette (docs/TUI-DESIGN.md): every component imports its color from here
// rather than hardcoding a literal. `error`/`warning` carry no hue — ERROR_MARK/WARNING_MARK below
// are what distinguishes an alert from ordinary text now that color no longer does, and `selected`
// is the reverse-video row token (see ListRow, components.tsx). ANSI-16 color names only, with one
// exception — `userBg` below — Ink's <Text color>/<Text backgroundColor> accept both directly.
export const theme = {
  error: "white",
  warning: "white",
  selected: "black",
  muted: "gray",
  // A confirmed, deliberate second use of background color (docs/TUI-DESIGN.md) — the user-message
  // row band, not an oversight of the "reverse-video row only" rule `selected` above follows. An
  // explicit hex value, not the ANSI-16 `"gray"` every other token here uses: plain `"gray"`
  // downsamples to a near-white on some terminals' own ANSI-16 palettes, reading as washed-out and
  // low-contrast against the white/light-gray text sitting on it — this dark-charcoal value renders
  // consistently across terminals regardless of how they resolve ANSI-16 names.
  userBg: "#333333",
} as const;

// Prefixed onto an alert addressed to the user (a failure or a question) at the TUI call site —
// never inside a shared formatter like approvalPromptText, which the non-interactive CLI path also
// calls and must not have this mark applied to.
export const ERROR_MARK = "✕ ";
export const WARNING_MARK = "! ";
