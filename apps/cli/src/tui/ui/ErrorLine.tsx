/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { ERROR_MARK, theme } from "../theme/theme";
import { singleLine } from "../util/format";

// Same OpenTUI truncate rule as ListRow: sibling <text> nodes and wrapMode none.
export function ErrorLine({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <box flexDirection="row">
      <text fg={theme.error} attributes={TextAttributes.BOLD} flexShrink={0}>
        {ERROR_MARK}
      </text>
      <text fg={theme.error} attributes={TextAttributes.BOLD} truncate wrapMode="none">
        {singleLine(message)}
      </text>
    </box>
  );
}
