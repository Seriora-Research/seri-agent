import { useRef, useState } from "react";
import type { TranscriptEntry } from "../util/format";
import { createTranscriptMeasureCache } from "../util/transcriptMeasureCache";
import {
  offsetsFromHeights,
  visibleTranscriptWindow,
  type VisibleTranscriptWindow,
} from "../util/visibleTranscriptWindow";

export type TranscriptWindowMetrics = {
  scrollTop: number;
  viewportHeight: number;
  sticky: boolean;
  columns: number;
};

export function useTranscriptWindow(
  transcript: readonly TranscriptEntry[],
  metrics: TranscriptWindowMetrics | undefined,
): VisibleTranscriptWindow & {
  onRowSizeChange: (entry: TranscriptEntry) => (this: { height: number }) => void;
} {
  const [, setGen] = useState(0);
  const cacheRef = useRef(createTranscriptMeasureCache(() => setGen((g) => g + 1)));
  const prevColumns = useRef(metrics?.columns);

  if (metrics !== undefined && prevColumns.current !== metrics.columns) {
    cacheRef.current.reset();
    prevColumns.current = metrics.columns;
  }

  const heights = cacheRef.current.sync(transcript);

  if (metrics === undefined) {
    return {
      start: 0,
      end: transcript.length,
      topSpacer: 0,
      bottomSpacer: 0,
      onRowSizeChange: cacheRef.current.handlerFor,
    };
  }

  const offsets = offsetsFromHeights(heights, transcript.length);
  const win = visibleTranscriptWindow({
    length: transcript.length,
    offsets,
    scrollTop: metrics.scrollTop,
    viewportHeight: metrics.viewportHeight,
    sticky: metrics.sticky,
  });
  return { ...win, onRowSizeChange: cacheRef.current.handlerFor };
}
