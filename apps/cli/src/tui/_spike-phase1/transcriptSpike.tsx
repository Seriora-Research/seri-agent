/** @jsxImportSource @opentui/react */
// THROWAWAY SPIKE — Phase 1 of docs/specs/025-tui-opentui-migration/tasks.md. Not production code:
// answers two open questions from the migration research (does <scrollbox> need a
// useBoxMetrics-equivalent measured-height readback?) against seri's REAL format.ts
// wrapping/measurement pipeline, not a synthetic transcript. Deleted before Phase 2's real
// app.tsx rewrite starts — nothing here is meant to survive.

import type { BoxRenderable } from "@opentui/core";
import { useRef } from "react";
import {
  type TranscriptEntry,
  transcriptRowsProps,
  transcriptVisualRows,
  visibleTranscript,
} from "../format";

// The CURRENT (App.tsx) shape: a fixed-height viewport fed a pre-sliced window of rows, sized by
// a measured-height readback. Kept here only as the comparison baseline for ScrollboxTranscript
// below — this is what Phase 1 is asking whether <scrollbox> can replace outright.
export function SlicedTranscript({
  entries,
  columns,
  viewportRows,
}: {
  entries: TranscriptEntry[];
  columns: number;
  viewportRows: number;
}) {
  const rows = transcriptRowsProps(visibleTranscript(entries, viewportRows, 0, columns));
  return (
    <box flexDirection="column" height={viewportRows}>
      {rows.map((row, index) => (
        <text key={index} bg={row.backgroundColor}>
          {row.text}
        </text>
      ))}
    </box>
  );
}

// The candidate replacement: the FULL wrapped transcript handed to <scrollbox> with
// stickyScroll/stickyStart="bottom" — no measured height read anywhere, no manual windowing.
// If this renders and tracks the tail correctly on its own, <scrollbox> does not need a
// useBoxMetrics equivalent for the transcript's own sizing.
export function ScrollboxTranscript({
  entries,
  columns,
}: {
  entries: TranscriptEntry[];
  columns: number;
}) {
  const total = transcriptVisualRows(entries, columns);
  const rows = transcriptRowsProps(visibleTranscript(entries, total, 0, columns));
  return (
    <scrollbox stickyScroll stickyStart="bottom" flexGrow={1}>
      {rows.map((row, index) => (
        <text key={index} bg={row.backgroundColor}>
          {row.text}
        </text>
      ))}
    </scrollbox>
  );
}

// Tests whether a plain flexGrow <box> (the shape App.tsx's viewportRef box already is) exposes a
// post-layout measured-dimensions readback at all, independent of whether <scrollbox> ends up
// needing one. `onSizeChange` is a renderable-level option (Renderable.d.ts), not a React hook —
// it fires whenever Yoga's own computed size for this node changes, which is the same fact
// useBoxMetrics(viewportRef) polls for via an effect keyed on the DOM element.
export function MeasuredBox({
  onMeasured,
  children,
}: {
  onMeasured: (height: number, width: number) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<BoxRenderable>(null);
  return (
    <box
      ref={ref}
      flexGrow={1}
      minHeight={0}
      onSizeChange={function onSizeChange(this: BoxRenderable) {
        onMeasured(this.height, this.width);
      }}
    >
      {children}
    </box>
  );
}
