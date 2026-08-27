/** @jsxImportSource @opentui/react */
import { getTreeSitterClient } from "@opentui/core";
import { memo } from "react";
import { syntaxStyle } from "../theme/syntaxStyle";
import { theme } from "../theme/theme";
import type { TranscriptEntry } from "../util/format";

// Its own memoized component, not an inline `.map()` in App's own JSX: `state.transcript`'s
// reference only changes on an actual append (state/reducer.ts), so `memo` here lets React skip
// rebuilding and re-diffing the whole elements array on a render triggered by unrelated state (a
// streamed token's `state.turn.tokens` tick, a scroll-banner flip) — not just skip the per-row
// markdown work `TranscriptRow`'s own `memo` (below) already bails out of.
export const TranscriptList = memo(function TranscriptList({
  transcript,
}: {
  transcript: TranscriptEntry[];
}) {
  return (
    <>
      {transcript.map((entry, index) => (
        <TranscriptRow key={index} entry={entry} />
      ))}
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
// paints into. `role === "user"` gets `theme.userBg`'s background band, `alignSelf="flex-start"` so
// the box shrinks to its own wrapped content's width instead of stretching to the transcript's full
// width (Yoga's default cross-axis behavior for a column-flex parent's children, which a plain
// `<text bg=...>` never hit since a text node's own background already stops at its own
// characters). A muted system entry with `markdown` set (the archivist summary) is the one
// exception among non-assistant rows: it reuses the same `<markdown>` path, `fg={theme.muted}`,
// and no `●` / `BULLET_GUTTER` — a secondary note, not an answer. Everything else (tool
// calls/results/errors/done markers, and the archivist stats line) stays plain text: none of
// those are model prose, and a tool result can legitimately contain a literal `*`/`#`/backtick that
// must render as-is, not get parsed as markdown syntax.
// Memoized: `TranscriptList` above re-runs on every actual transcript append, but each entry's own
// object reference is stable across renders (state/reducer.ts only appends, never replaces existing
// entries) — so `memo` lets React skip re-invoking this for every already-rendered row (assistant
// rows re-parse and re-highlight markdown, the expensive case) and only render newly appended ones.
const TranscriptRow = memo(function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  if (entry.role === "assistant") {
    return (
      // minHeight={1}: without an in-flow bullet sibling, this box's height comes from `<markdown>`
      // alone — an assistant entry whose text is whitespace-only (reachable: `pushLine`,
      // state/reducer.ts, flushes on `state.streaming.length > 0`, which whitespace satisfies)
      // measures to zero rows and would otherwise make the whole entry, bullet included, disappear
      // instead of rendering a blank line the way the old row-flex layout did for free.
      <box minHeight={1}>
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
      <box backgroundColor={theme.userBg} alignSelf="flex-start">
        <text fg={theme.text}>{entry.text}</text>
      </box>
    );
  }
  if (entry.role === "system" && entry.muted && entry.markdown) {
    return (
      <markdown
        fg={theme.muted}
        content={entry.text}
        syntaxStyle={syntaxStyle}
        treeSitterClient={getTreeSitterClient()}
        streaming={false}
      />
    );
  }
  return <text fg={entry.muted ? theme.muted : theme.text}>{entry.text}</text>;
});
