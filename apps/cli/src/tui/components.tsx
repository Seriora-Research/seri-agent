import { Box, Text, useInput } from "ink";
import { singleLine } from "./format";
import { ERROR_MARK, selectedRowStyle, theme, WARNING_MARK } from "./theme";

// Each caller reserves exactly one row for an alert line like this (App.tsx's own
// APP_CHROME_ROWS for `commandError`, each panel's own budget for SetupEnterKey/
// ConfigEnterValue/AuthPanel's error line), but `message` can be an Error#message — unbounded
// length AND free to carry a literal `\n` (a multi-line validation error, a JSON-parse error
// citing surrounding context). Ink renders an embedded newline as a real line break regardless of
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

// The shared y/N confirm step every SetupPanel/ConfigPanel/PermissionsPanel dispatcher uses:
// Enter and anything unrecognised both cancel, only an explicit "y" confirms. `key.ctrl ||
// key.meta` and the `input.length === 0` guard ahead of the "y" check are what makes an arrow
// key or another navigation keypress a no-op here rather than falling through to the
// unrecognised-cancels branch and silently backing out of a destructive prompt. This includes
// Escape: `ConfirmPrompt` never inspects `key.escape`, and Ink strips the ESC byte from `input`
// before this handler ever sees it (verified against ink/build/hooks/use-input.js), so a bare
// Escape reaches here as an empty `input` and falls into the same no-op branch as any other
// stray keypress — it is inert here, not a cancel shortcut.
//
// `subject` builds its own "? [y]es / [N]o" affordance rather than taking a pre-composed
// `message` — the same reasoning `approvalPromptText` (cli/output.ts) already states for why its
// prompt text is one function instead of written out at each call site: the text that promises
// "N cancels" and the code that implements it must not be free to drift apart across callers.
export function ConfirmPrompt({
  subject,
  onConfirm,
  onCancel,
}: {
  subject: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (key.return) {
      onCancel();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.length === 0) return;
    if (input.toLowerCase() === "y") {
      onConfirm();
      return;
    }
    onCancel();
  });
  return <WarningBox message={`${subject}? [y]es / [N]o`} />;
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
