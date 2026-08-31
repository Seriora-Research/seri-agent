/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { FRAME } from "../theme/spacing";
import { theme, WARNING_MARK } from "../theme/theme";

// Callers pass already-composed prompt text (approvalPromptText, a "Remove X? [y]es / [N]o"
// confirm line) — unlike ErrorLine, nothing here calls `singleLine`, so an embedded newline in
// `message` is preserved, not collapsed.
export function WarningBox({ message }: { message: string }) {
  return (
    <box {...FRAME} borderColor={theme.warning}>
      <text fg={theme.warning} attributes={TextAttributes.BOLD}>
        {WARNING_MARK}
        {message}
      </text>
    </box>
  );
}
