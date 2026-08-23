/** @jsxImportSource @opentui/react */
// The live status region's elapsed-time + token-count indicator, shown for the duration of an
// in-flight turn (`turnStartedAt !== undefined`) and nothing while none is. A single derived
// clock, not a running counter: every tick recomputes `Date.now() - turnStartedAt` instead of
// incrementing a number, so a late/drifted `setInterval` tick self-corrects instead of
// accumulating error (vercel-labs/fx's own technique).
import { useEffect, useState } from "react";
import { theme } from "../theme/theme";
import { formatElapsed, formatTokenProgress, type TokenProgress } from "../util/format";

export function TurnStatus({
  turnStartedAt,
  tokenProgress,
}: {
  turnStartedAt: number | undefined;
  tokenProgress: TokenProgress | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (turnStartedAt === undefined) return;
    // Set immediately on mount/turn-start, not just on the first 1s tick — otherwise the elapsed
    // display's first paint would be up to a second late, sitting on the `now` a previous turn (or
    // the initial mount) left behind.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [turnStartedAt]);

  if (turnStartedAt === undefined) return undefined;
  const tokens = tokenProgress ? ` (${formatTokenProgress(tokenProgress)})` : "";
  return (
    <text fg={theme.muted}>
      {formatElapsed(now - turnStartedAt)}
      {tokens}
    </text>
  );
}
