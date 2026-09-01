import type { BoxRenderable } from "@opentui/core";
import { useRef, useState } from "react";
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
  length: number,
  metrics: TranscriptWindowMetrics | undefined,
): VisibleTranscriptWindow & {
  onRowSizeChange: (index: number) => (this: BoxRenderable) => void;
} {
  const heightsRef = useRef<(number | undefined)[]>([]);
  const measureCache = useRef(new Map<number, (this: BoxRenderable) => void>());
  const prevColumns = useRef(metrics?.columns);
  const [, setGen] = useState(0);

  if (metrics !== undefined && prevColumns.current !== metrics.columns) {
    heightsRef.current = [];
    prevColumns.current = metrics.columns;
  }
  if (heightsRef.current.length > length) {
    heightsRef.current.length = length;
  }

  const onRowSizeChange = (index: number) => {
    let fn = measureCache.current.get(index);
    if (fn === undefined) {
      fn = function onRowSizeChange(this: BoxRenderable) {
        const next = this.height;
        if (next <= 0) return;
        if (heightsRef.current[index] === next) return;
        heightsRef.current[index] = next;
        setGen((gen) => gen + 1);
      };
      measureCache.current.set(index, fn);
    }
    return fn;
  };

  if (metrics === undefined) {
    return { start: 0, end: length, topSpacer: 0, bottomSpacer: 0, onRowSizeChange };
  }

  const offsets = offsetsFromHeights(heightsRef.current, length);
  const win = visibleTranscriptWindow({
    length,
    offsets,
    scrollTop: metrics.scrollTop,
    viewportHeight: metrics.viewportHeight,
    sticky: metrics.sticky,
  });
  return { ...win, onRowSizeChange };
}
