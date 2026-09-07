/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import type { ModelProvider } from "@seri/model-catalog";
import { theme } from "../../theme/theme";
import { formatHomePath } from "../../util/format";

export type SplashBannerInfo = {
  version: string;
  model: string;
  provider: ModelProvider;
  via: string;
  cwd: string;
  home: string;
};

const MARK = "▁▁▄▄▄▁▁";

export function SplashBanner({ info }: { info: SplashBannerInfo }) {
  const directory = formatHomePath(info.cwd, info.home);
  const model = `${info.model} · ${info.via}`;
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg={theme.text} flexShrink={0}>
        {`${MARK}  `}
      </text>
      <text attributes={TextAttributes.BOLD} flexShrink={0}>
        seri
      </text>
      <text fg={theme.muted} flexShrink={0}>
        {` v${info.version}  `}
      </text>
      <text fg={theme.muted} flexShrink={0}>
        {`${model}  `}
      </text>
      <text fg={theme.muted} truncate wrapMode="none" flexGrow={1}>
        {directory}
      </text>
    </box>
  );
}
