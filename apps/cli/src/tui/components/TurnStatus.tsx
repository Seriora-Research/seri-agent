/** @jsxImportSource @opentui/react */
// The live status region's elapsed-time + token-count indicator. Mounted only for the duration of
// an in-flight turn, keyed on `startedAt` — see app.tsx's own comment on that `key` for why this
// component's `useState(() => Date.now())` initializer needs a genuinely fresh mount per turn. A
// single derived clock, not a running counter: every tick recomputes `Date.now() - startedAt`
// instead of incrementing a number, so a late/drifted `setInterval` tick self-corrects instead of
// accumulating error (vercel-labs/fx's own technique).
import { useEffect, useState } from "react";
import { theme } from "../theme/theme";
import { formatElapsed, formatTokenProgress, type TokenProgress } from "../util/format";

export function TurnStatus({
  startedAt,
  tokenProgress,
}: {
  startedAt: number;
  tokenProgress: TokenProgress;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // `truncate wrapMode="none"`: app.tsx reserves exactly one row for this component
  // (`scrollboxHeight = transcriptHeight - 1` while a turn is active), inside a wrapping box with
  // `overflow="hidden"`. Without this prop, a long elapsed+token string could soft-wrap onto a
  // second row, which that fixed one-row budget has no room for — the second row would overflow
  // the wrapping box and get silently clipped by `overflow="hidden"` instead of just truncating
  // gracefully, the same reasoning `ErrorLine.tsx`/`ListRow.tsx` apply to their own single-line
  // rows.
  return (
    <text fg={theme.muted} truncate wrapMode="none">
      {formatElapsed(now - startedAt)} ({formatTokenProgress(tokenProgress)})
    </text>
  );
}
