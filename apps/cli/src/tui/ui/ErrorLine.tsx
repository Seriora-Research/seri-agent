/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { singleLine } from "../util/format";
import { ERROR_MARK, theme } from "../theme/theme";

// Each caller reserves exactly one row for an alert line like this (app.tsx's own APP_CHROME_ROWS
// for `commandError`, each panel's own budget for SetupEnterKey/ConfigEnterValue/AuthPanel's error
// line), but `message` can be an Error#message — unbounded length AND free to carry a literal `\n`
// (a multi-line validation error, a JSON-parse error citing surrounding context). OpenTUI renders
// an embedded newline as a real line break the same way Ink did — `singleLine` collapses any
// embedded break first, then `truncate` guards what's left from overflowing on a narrow terminal.
// Either alone would leave the other case free to push an open panel's own bottom row past the
// alt-screen viewport.
export function ErrorLine({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <text fg={theme.error} attributes={TextAttributes.BOLD} truncate>
      {ERROR_MARK}
      {singleLine(message)}
    </text>
  );
}
