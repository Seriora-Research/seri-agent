import { Box, Text } from "ink";
import { singleLine } from "./format";
import { ERROR_MARK, selectedRowStyle, theme, WARNING_MARK } from "./theme";

// Each caller reserves exactly one row for an alert line like this (App.tsx's own
// APP_CHROME_ROWS for `commandError`, each panel's own budget for SetupEnterKey/
// ConfigEnterValue's error line), but `message` can be an Error#message — unbounded length AND
// free to carry a literal `\n` (a multi-line validation error, a JSON-parse error citing
// surrounding context). Ink renders an embedded newline as a real line break regardless of
// `wrap`, which only governs a single line's own overflow — `singleLine` collapses any embedded
// break first, then `wrap="truncate-end"` guards what's left from overflowing on a narrow
// terminal. Either alone would leave the other case free to push an open panel's own bottom row
// past the alt-screen viewport.
export function ErrorLine({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <Text color={theme.error} bold wrap="truncate-end">
      {ERROR_MARK}
      {singleLine(message)}
    </Text>
  );
}

// Callers pass already-composed prompt text (approvalPromptText, a "Remove X? [y]es / [N]o"
// confirm line) — unlike ErrorLine, nothing here calls `singleLine`, so an embedded newline in
// `message` is preserved, not collapsed.
export function WarningBox({ message }: { message: string }) {
  return (
    <Box borderStyle="single" borderColor={theme.warning}>
      <Text color={theme.warning} bold>
        {WARNING_MARK}
        {message}
      </Text>
    </Box>
  );
}

// The selection marker + row highlight shared by every selectable-list panel. `wrap=
// "truncate-end"` applies unconditionally, not per caller: every list panel budgets exactly one
// row per list row (PANEL_CHROME_ROWS, format.ts), and Ink's default wrap would soft-wrap an
// over-width label into a second row and overflow that budget.
export function ListRow({ selected, label }: { selected: boolean; label: string }) {
  return (
    <Text {...selectedRowStyle(selected)} wrap="truncate-end">
      {selected ? "> " : "  "}
      {label}
    </Text>
  );
}
