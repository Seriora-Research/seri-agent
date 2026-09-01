/** @jsxImportSource @opentui/react */
import { theme } from "../theme/theme";

export function OptionKeys({ labels }: { labels: readonly string[] }) {
  return (
    <box flexDirection="row">
      <text flexShrink={0}>{"  "}</text>
      {labels.map((lab, i) => (
        <box key={lab} flexDirection="row">
          {i > 0 && (
            <text fg={theme.muted} flexShrink={0}>
              {"  ·  "}
            </text>
          )}
          <text fg={theme.text} flexShrink={0}>
            {lab}
          </text>
        </box>
      ))}
    </box>
  );
}
