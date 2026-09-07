/** @jsxImportSource @opentui/react */
import { theme } from "../theme/theme";

// OpenTUI 0.5.6 INVERSE sets bg to the same RGB as fg, so selected rows use selectedBg/selectedFg.
// OpenTUI paints a blank line if one truncated <text> has two children. wrapMode none is required for truncate to clip.
export function ListRow({ selected, label }: { selected: boolean; label: string }) {
  const fg = selected ? theme.selectedFg : undefined;
  return (
    <box flexDirection="row" backgroundColor={selected ? theme.selectedBg : undefined}>
      <text fg={fg} bg={selected ? theme.selectedBg : undefined} flexShrink={0}>
        {selected ? "> " : "  "}
      </text>
      <text
        fg={fg}
        bg={selected ? theme.selectedBg : undefined}
        truncate
        wrapMode="none"
        flexGrow={1}
      >
        {label}
      </text>
    </box>
  );
}
