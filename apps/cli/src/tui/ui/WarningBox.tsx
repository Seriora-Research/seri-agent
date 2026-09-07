/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { FRAME } from "../theme/spacing";
import { theme, WARNING_MARK } from "../theme/theme";

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
