// The TUI's monochrome palette (docs/TUI-DESIGN.md): every component imports its color from here
// rather than hardcoding a literal. `error`/`warning` carry no hue — ERROR_MARK/WARNING_MARK below
// are what distinguishes an alert from ordinary text now that color no longer does, and `selected`
// is the reverse-video row token (see ListRow, components.tsx). ANSI-16 color names only — Ink's
// <Text color> accepts these directly.
export const theme = {
  error: "white",
  warning: "white",
  selected: "black",
  muted: "gray",
} as const;

// Prefixed onto an alert addressed to the user (a failure or a question) at the TUI call site —
// never inside a shared formatter like approvalPromptText, which the non-interactive CLI path also
// calls and must not have this mark applied to.
export const ERROR_MARK = "✕ ";
export const WARNING_MARK = "! ";
