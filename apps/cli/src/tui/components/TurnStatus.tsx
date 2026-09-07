/** @jsxImportSource @opentui/react */
import { useEffect, useState } from "react";
import { theme } from "../theme/theme";
import {
  formatElapsed,
  formatLiveThinkingStatus,
  formatTokenProgress,
  type TokenProgress,
} from "../util/format";

export function TurnStatus({
  startedAt,
  tokenProgress,
  pendingLiveOutputEstimate,
  subscribePendingLive,
  thinking = false,
  thinkingExpanded = false,
  toolInFlight = false,
}: {
  startedAt: number;
  tokenProgress: TokenProgress;
  pendingLiveOutputEstimate?: () => number;
  subscribePendingLive?: (listener: () => void) => () => void;
  thinking?: boolean;
  thinkingExpanded?: boolean;
  toolInFlight?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [pendingExtra, setPendingExtra] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (subscribePendingLive === undefined || pendingLiveOutputEstimate === undefined) return;
    const sync = () => setPendingExtra(pendingLiveOutputEstimate());
    sync();
    return subscribePendingLive(sync);
  }, [subscribePendingLive, pendingLiveOutputEstimate]);

  // Without truncate wrapMode none, OpenTUI soft-wraps this string onto a second row the one-row reservation cannot keep.
  const elapsed = formatElapsed(now - startedAt);
  const tokens = formatTokenProgress({
    ...tokenProgress,
    liveOutputEstimate: tokenProgress.liveOutputEstimate + pendingExtra,
  });
  return (
    <text fg={theme.muted} truncate wrapMode="none">
      {thinking && !toolInFlight
        ? formatLiveThinkingStatus(thinkingExpanded, elapsed, tokens)
        : `${elapsed} ${tokens}`}
    </text>
  );
}
