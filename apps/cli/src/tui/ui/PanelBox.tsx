/** @jsxImportSource @opentui/react */
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { FRAME } from "../theme/spacing";
import { theme } from "../theme/theme";
import { composeBorderTitle } from "../util/borderTitle";
import { DEFAULT_COLUMNS } from "../util/format";

// The titled FRAME every panel and dialog shares: command on the left of the top rule, Esc on
// the right. InputBox stays an untitled FRAME so a panel and the prompt cannot be mistaken for
// each other.
export function PanelBox({
  title,
  right = "Esc",
  titleColor = theme.muted,
  borderColor,
  flexGrow,
  children,
}: {
  title: string;
  right?: string;
  titleColor?: string;
  borderColor?: string;
  flexGrow?: number;
  children: ReactNode;
}) {
  const { width } = useTerminalDimensions();
  const columns = width || DEFAULT_COLUMNS;
  return (
    <box
      {...FRAME}
      flexDirection="column"
      flexGrow={flexGrow}
      borderColor={borderColor ?? theme.border}
      title={composeBorderTitle(title, right, columns)}
      titleColor={titleColor}
      titleAlignment="left"
    >
      {children}
    </box>
  );
}
