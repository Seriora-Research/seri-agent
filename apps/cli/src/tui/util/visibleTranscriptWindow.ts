export const ESTIMATE_ROWS = 1;
export const OVERSCAN_ROWS = 40;
export const COLD_START_COUNT = 30;
export const SCROLL_QUANTUM = 20;

export type VisibleTranscriptWindow = {
  start: number;
  end: number;
  topSpacer: number;
  bottomSpacer: number;
};

export function offsetsFromHeights(
  heights: ReadonlyArray<number | undefined>,
  length: number,
  estimate = ESTIMATE_ROWS,
): Float64Array {
  const offsets = new Float64Array(length + 1);
  for (let i = 0; i < length; i++) {
    offsets[i + 1] = offsets[i] + (heights[i] ?? estimate);
  }
  return offsets;
}

export function quantizeScrollTop(scrollTop: number, quantum = SCROLL_QUANTUM): number {
  if (scrollTop <= 0) return 0;
  return Math.floor(scrollTop / quantum) * quantum;
}

function findStart(offsets: ArrayLike<number>, length: number, localLo: number): number {
  if (length === 0) return 0;
  if (localLo <= 0) return 0;
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= localLo) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, length - 1);
}

function findEnd(offsets: ArrayLike<number>, length: number, localHi: number): number {
  if (length === 0) return 0;
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < localHi) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function visibleTranscriptWindow(opts: {
  length: number;
  offsets: ArrayLike<number>;
  scrollTop: number;
  viewportHeight: number;
  sticky: boolean;
  overscan?: number;
}): VisibleTranscriptWindow {
  const { length, offsets, sticky } = opts;
  if (length === 0) {
    return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 };
  }
  const overscan = opts.overscan ?? OVERSCAN_ROWS;
  const total = offsets[length] ?? 0;
  const viewportHeight = opts.viewportHeight;

  if (viewportHeight <= 0) {
    const count = Math.min(length, COLD_START_COUNT);
    if (sticky) {
      const start = length - count;
      return {
        start,
        end: length,
        topSpacer: Math.round(offsets[start] ?? 0),
        bottomSpacer: 0,
      };
    }
    return {
      start: 0,
      end: count,
      topSpacer: 0,
      bottomSpacer: Math.round(total - (offsets[count] ?? 0)),
    };
  }

  let start: number;
  let end: number;
  if (sticky) {
    const localLo = total - viewportHeight - overscan;
    start = findStart(offsets, length, localLo);
    end = length;
  } else {
    const localLo = opts.scrollTop - overscan;
    const localHi = opts.scrollTop + viewportHeight + overscan;
    start = findStart(offsets, length, localLo);
    end = findEnd(offsets, length, localHi);
    if (end <= start) end = Math.min(length, start + 1);
  }

  return {
    start,
    end,
    topSpacer: Math.round(offsets[start] ?? 0),
    bottomSpacer: Math.round(total - (offsets[end] ?? 0)),
  };
}
