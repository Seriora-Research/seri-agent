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

  // `truncate wrapMode="none"`: kept as a single-line display choice, not a reserved-row-budget
  // requirement — app.tsx's transcript is a native `<scrollbox>` now, which has no fixed-height
  // "row budget" for this component to overflow. A one-line elapsed+token string reads better
  // truncated than soft-wrapped across two rows on a narrow terminal, the same reasoning
  // `ErrorLine.tsx`/`ListRow.tsx` already apply to their own single-line rows.
  return (
    <text fg={theme.muted} truncate wrapMode="none">
      {formatElapsed(now - startedAt)} ({formatTokenProgress(tokenProgress)})
    </text>
  );
}
