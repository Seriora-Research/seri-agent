// The TUI's single source of color: every component imports its color from here rather than
// hardcoding a literal, so the ANSI-only decision (research-spec, no hex/ansi256 for this stage) has
// exactly one place to hold the line. ANSI-16 color names only — Ink's <Text color> accepts these
// directly.
export const theme = {
  error: "red",
  warning: "yellow",
  accent: "cyan",
  muted: "gray",
} as const;
