/** @jsxImportSource @opentui/react */
// The live status region's elapsed-time + token-count indicator. Mounted only for the duration of
// an in-flight turn, keyed on `startedAt` (app.tsx) so every turn gets a fresh instance rather than
// this component's own `now` state surviving a `startedAt` prop transition — a fresh mount's
// `useState(() => Date.now())` initializer always reflects the CURRENT turn's own start, so there is
// no stale `now` left over from a previous turn to guard against. A single derived clock, not a
// running counter: every tick recomputes `Date.now() - startedAt` instead of incrementing a number,
// so a late/drifted `setInterval` tick self-corrects instead of accumulating error (vercel-labs/fx's
// own technique).
import { useEffect, useState } from "react";
import { theme } from "../theme/theme";
import { formatElapsed, formatTokenProgress, type TokenProgress } from "../util/format";

export function TurnStatus({
  startedAt,
  tokenProgress,
}: {
  startedAt: number;
  tokenProgress: TokenProgress | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const tokens = tokenProgress ? ` (${formatTokenProgress(tokenProgress)})` : "";
  return (
    <text fg={theme.muted}>
      {formatElapsed(now - startedAt)}
      {tokens}
    </text>
  );
}
