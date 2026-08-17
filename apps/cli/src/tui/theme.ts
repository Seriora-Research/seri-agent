import type { TextProps } from "ink";

// The TUI's monochrome palette (docs/TUI-DESIGN.md): every component imports its color from here
// rather than hardcoding a literal. `error`/`warning` carry no hue — ERROR_MARK/WARNING_MARK below
// are what distinguishes an alert from ordinary text now that color no longer does, and `selected`
// is the reverse-video row token (see selectedRowStyle). ANSI-16 color names only — Ink's <Text
// color> accepts these directly.
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

// The reverse-video row highlight — the theme-token half of ListRow (components.tsx), which is
// the one caller. `backgroundColor` alone would paint default-foreground text on ANSI black,
// which in many dark themes is indistinguishable from the terminal background — `inverse` is
// what actually swaps the glyphs to the terminal's own default foreground on top of that band,
// verified against Ink's own Text.js applying chalk.inverse last.
export function selectedRowStyle(
  isSelected: boolean,
): Pick<TextProps, "backgroundColor" | "inverse"> {
  return isSelected ? { backgroundColor: theme.selected, inverse: true } : {};
}
