/** @jsxImportSource @opentui/react */
// The welcome splash's identity block — product, version, and the two facts a user checks before
// typing anything: which model this session will dispatch to, and which directory it is pointed at.
// Rendered above WelcomeSplashPanel's own menu, inside that panel's border, so the whole intro is
// one bordered unit rather than two stacked boxes.
//
// Everything here is a prop, computed by `welcomeSplash.ts` — this component reads neither
// `node:os` nor config.json, so it renders identically under a test mount and a real launch.
// `home` in particular is passed rather than read: `formatHomePath` (util/format.ts) is the pure
// half of the `directory` row, and keeping its input a parameter is what lets a Windows path be
// asserted from a POSIX CI runner.
//
// `route`/`catalog` are deliberately NOT used for the model row. Neither exists at this point in
// startup (app.tsx's own `route` comment, welcomeSplash.ts) — the splash mounts before
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
  cwd: string;
  home: string;
};

// brand/logo.jpg reduced to one row of text: a half-disc rising out of a hairline horizon. Built
// from `▁` (lower one-eighth block) and `▄` (lower half block) so both sit on the same baseline
// within a single cell row — the sun's mass reads as taller than the horizon without needing a
// second row of art. One row rather than a multi-row block on purpose: the splash is an intro, not
// a title screen, and a mark that costs one row survives a short terminal intact.
const MARK = "▁▁▄▄▄▁▁";

// Wide enough for "directory" plus a two-column gutter, so both values start at the same screen
// column. Two rows is not a table worth generating; the pair below is the whole set.
const LABEL_WIDTH = 11;

export function SplashBanner({ info }: { info: SplashBannerInfo }) {
  const rows = [
    ["model", `${info.model} · ${info.provider}`],
    ["directory", formatHomePath(info.cwd, info.home)],
  ] as const;

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={theme.text} flexShrink={0}>
          {`${MARK}  `}
        </text>
        <text attributes={TextAttributes.BOLD} flexShrink={0}>
          seri
        </text>
        <text fg={theme.muted} flexShrink={0}>
          {` v${info.version}`}
        </text>
      </box>
      {rows.map(([label, value]) => (
        // Same two-sibling-`<text>` split ui/ListRow.tsx documents: the truncated node gets exactly
        // one child, and the fixed-width label sits outside it with `flexShrink={0}` so a narrow
        // terminal clips the value rather than eating the label's padding. `wrapMode="none"` is
        // what makes `truncate` clip instead of soft-wrapping a long model id onto a second row.
        <box key={label} flexDirection="row">
          <text fg={theme.muted} flexShrink={0}>
            {label.padEnd(LABEL_WIDTH)}
          </text>
          <text fg={theme.muted} truncate wrapMode="none" flexGrow={1}>
            {value}
          </text>
        </box>
      ))}
    </box>
  );
}
