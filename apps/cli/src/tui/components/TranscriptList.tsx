/** @jsxImportSource @opentui/react */
import { getTreeSitterClient } from "@opentui/core";
import { memo } from "react";
import {
  useTranscriptWindow,
  type TranscriptWindowMetrics,
} from "../hooks/useTranscriptWindow";
import { gapBefore } from "../theme/spacing";
import { syntaxStyle } from "../theme/syntaxStyle";
import { theme } from "../theme/theme";
import type { TranscriptEntry } from "../util/format";

// Its own memoized component, not an inline `.map()` in App's own JSX: `state.transcript`'s
// reference only changes on an actual append (state/reducer.ts), so `memo` here lets React skip
// rebuilding and re-diffing the whole elements array on a render triggered by unrelated state (a
// streamed token's `state.turn.tokens` tick, a scroll-banner flip) — not just skip the per-row
// markdown work `TranscriptRow`'s own `memo` (below) already bails out of.
//
// When App passes window metrics, only viewport+overscan rows mount; spacer boxes stand in for
// the unmounted prefix/suffix so the scrollbox's `scrollHeight` stays the height of the full
// array. Isolated mounts (tests, ChildTranscript) omit metrics and still map every entry.
export const TranscriptList = memo(function TranscriptList({
  transcript,
  scrollTop,
  viewportHeight,
  sticky,
  columns,
}: {
  transcript: TranscriptEntry[];
  scrollTop?: number;
  viewportHeight?: number;
  sticky?: boolean;
  columns?: number;
}) {
  const metrics: TranscriptWindowMetrics | undefined =
    viewportHeight === undefined || sticky === undefined || scrollTop === undefined || columns === undefined
      ? undefined
      : { scrollTop, viewportHeight, sticky, columns };
  const { start, end, topSpacer, bottomSpacer, onRowSizeChange } = useTranscriptWindow(
    transcript.length,
    metrics,
  );

  if (metrics === undefined) {
    return (
      <>
        {transcript.map((entry, index) => (
          <TranscriptRow
            key={index}
            entry={entry}
            gap={gapBefore(transcript[index - 1]?.role, entry.role)}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {topSpacer > 0 && <box height={topSpacer} flexShrink={0} />}
      {transcript.slice(start, end).map((entry, offset) => {
        const index = start + offset;
        return (
          <box key={index} flexShrink={0} onSizeChange={onRowSizeChange(index)}>
            <TranscriptRow
              entry={entry}
              gap={gapBefore(transcript[index - 1]?.role, entry.role)}
            />
          </box>
        );
      })}
      {bottomSpacer > 0 && <box height={bottomSpacer} flexShrink={0} />}
    </>
  );
});

// The `●` marker's own width plus one gutter column, reserved on the assistant markdown block
// below via `paddingLeft` so wrapped/multi-line content never starts under the bullet — kept as
// one named pair (glyph + derived width) instead of two independently-hardcoded numbers, so a
// future change to the marker can't silently desync the gutter from what it's actually leaving
// room for.
const BULLET = "●";
const BULLET_GUTTER = BULLET.length + 1;

// One transcript entry's own render, split by role. `role === "assistant"` gets real markdown
// (bold/headers/lists/links/tables/monochrome-syntax-highlighted code) with the `●` marker
// rendered as an absolutely-positioned overlay (out of flex flow) rather than an in-flow row
// sibling, so it survives a multi-line markdown block as one glyph pinned to the row's own top-left
// corner, not repeated or lost mid-wrap: a `flexDirection="row"` sibling's cross-axis never grows
// to fit `<markdown>`'s wrapped content (reproduced live — that shape clipped every multi-line
// assistant message to one row), so the bullet has to sit outside that flex flow entirely for the
// block to size itself off `<markdown>` alone. `BULLET_GUTTER` reserves the column(s) the overlay
// paints into. `role === "user"` gets `theme.userBg`'s background band, stretched to the
// transcript's full width (Yoga's default cross-axis behavior for a column-flex parent's children,
// which a plain `<text bg=...>` never gets since a text node's own background stops at its own
// characters). No horizontal padding on it, unlike every other surface: a padding cell belongs to
// the box rather than to any text node, so a drag beginning on one starts no selection at all —
// and the left edge is where a reader starts a drag. Verified against
// tests/tui/transcriptSelection.test.tsx, which went from selecting the row to reporting no
// selection. The band still reads as a turn marker rather than a stray
// smudge the width of its own text. A muted system entry with `markdown` set (the archivist
// summary) is the one exception among non-assistant rows: it reuses the same `<markdown>` path,
// `fg={theme.muted}`, and no `●` / `BULLET_GUTTER` — a secondary note, not an answer. Everything
// else (tool calls/results/errors/done markers, and the archivist stats line) stays plain text:
// none of those are model prose, and a tool result can legitimately contain a literal
// `*`/`#`/backtick that must render as-is, not get parsed as markdown syntax.
// Memoized: `TranscriptList` above re-runs on every actual transcript append, but each entry's own
// object reference is stable across renders (state/reducer.ts only appends, never replaces existing
// entries) — so `memo` lets React skip re-invoking this for every already-rendered row (assistant
// rows re-parse and re-highlight markdown, the expensive case) and only render newly appended ones.
const TranscriptRow = memo(function TranscriptRow({
  entry,
  gap,
}: {
  entry: TranscriptEntry;
  gap: 0 | 1;
}) {
  if (entry.role === "assistant") {
    return (
      // minHeight={1}: without an in-flow bullet sibling, this box's height comes from `<markdown>`
      // alone — an assistant entry whose text is whitespace-only (reachable: `pushLine`,
      // state/reducer.ts, flushes on `state.streaming.length > 0`, which whitespace satisfies)
      // measures to zero rows and would otherwise make the whole entry, bullet included, disappear
      // instead of rendering a blank line the way the old row-flex layout did for free.
      <box minHeight={1} marginTop={gap}>
        <text fg={theme.text} position="absolute" top={0} left={0}>
          {BULLET}
        </text>
        <markdown
          paddingLeft={BULLET_GUTTER}
          fg={theme.text}
          content={entry.text}
          syntaxStyle={syntaxStyle}
          treeSitterClient={getTreeSitterClient()}
          streaming={false}
        />
      </box>
    );
  }
  if (entry.role === "user") {
    return (
      <box backgroundColor={theme.userBg} marginTop={gap}>
        <text fg={theme.text}>{entry.text}</text>
      </box>
    );
  }
  if (entry.role === "system" && entry.muted && entry.markdown) {
    return (
      <markdown
        marginTop={gap}
        fg={theme.muted}
        content={entry.text}
        syntaxStyle={syntaxStyle}
        treeSitterClient={getTreeSitterClient()}
        streaming={false}
      />
    );
  }
  return (
    <text marginTop={gap} fg={entry.muted ? theme.muted : theme.text}>
      {entry.text}
    </text>
  );
});
