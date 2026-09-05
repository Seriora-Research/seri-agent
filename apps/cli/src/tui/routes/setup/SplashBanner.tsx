/** @jsxImportSource @opentui/react */
// The welcome splash's identity block — product, version, and the two facts a user checks before
// typing anything: which model this session will dispatch to, and which directory it is pointed at.
// Rendered above WelcomeSplashPanel's own menu, inside that panel's border, so the whole intro is
// one bordered unit rather than two stacked boxes. One row: the mark, version, model · via,
// and directory, with no "model"/"directory" labels.
//
// Everything here is a prop, computed by `welcomeSplash.ts` — this component reads neither
// `node:os` nor config.json, so it renders identically under a test mount and a real launch.
// `home` in particular is passed rather than read: `formatHomePath` (util/format.ts) is the pure
// half of the directory fragment, and keeping its input a parameter is what lets a Windows path be
// asserted from a POSIX CI runner.
//
// `route`/`catalog` are deliberately NOT used for the model fragment. Neither exists at this point
// in startup (app.tsx's own `route` comment, welcomeSplash.ts) — the splash mounts before
// `prepareSession` has resolved anything. `resolveDefaultModel` is the one source that answers
// "what would this session dispatch to" without a PreparedRun, so the row reports the requested
// pair, not a resolved route: a reroute to a sibling provider can still happen on the first turn,
// and is announced in the transcript when it does.
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

// brand/logo.jpg reduced to one row of text: a half-disc rising out of a hairline horizon. Built
// from `▁` (lower one-eighth block) and `▄` (lower half block) so both sit on the same baseline
// within a single cell row — the sun's mass reads as taller than the horizon without needing a
// second row of art. One row rather than a multi-row block on purpose: the splash is an intro, not
// a title screen, and a mark that costs one row survives a short terminal intact.
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
