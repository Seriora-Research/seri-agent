import { describe, expect, test } from "bun:test";
import {
  COLD_START_COUNT,
  ESTIMATE_ROWS,
  OVERSCAN_ROWS,
  offsetsFromHeights,
  quantizeScrollTop,
  visibleTranscriptWindow,
} from "../../src/tui/util/visibleTranscriptWindow";

function heightsOf(length: number, rowHeight = ESTIMATE_ROWS): number[] {
  return Array.from({ length }, () => rowHeight);
}

describe("offsetsFromHeights", () => {
  test("unmeasured slots use the estimate", () => {
    const offsets = offsetsFromHeights([undefined, 4, undefined], 3, 1);
    expect(Array.from(offsets)).toEqual([0, 1, 5, 6]);
  });
});

describe("quantizeScrollTop", () => {
  test("zero stays zero so Home does not round into the first quantum", () => {
    expect(quantizeScrollTop(0)).toBe(0);
    expect(quantizeScrollTop(19)).toBe(0);
    expect(quantizeScrollTop(20)).toBe(20);
  });
});

describe("visibleTranscriptWindow", () => {
  test("empty list is zeros", () => {
    const offsets = offsetsFromHeights([], 0);
    expect(visibleTranscriptWindow({
      length: 0,
      offsets,
      scrollTop: 0,
      viewportHeight: 10,
      sticky: true,
    })).toEqual({ start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 });
  });

  test("sticky tail-walks so the last rows stay mounted and bottomSpacer is 0", () => {
    const length = 200;
    const offsets = offsetsFromHeights(heightsOf(length), length);
    const viewportHeight = 10;
    const win = visibleTranscriptWindow({
      length,
      offsets,
      scrollTop: 0,
      viewportHeight,
      sticky: true,
    });
    expect(win.end).toBe(length);
    expect(win.bottomSpacer).toBe(0);
    expect(win.start).toBe(length - viewportHeight - OVERSCAN_ROWS);
    expect(win.topSpacer).toBe(win.start * ESTIMATE_ROWS);
  });

  test("Home (not sticky, scrollTop 0) mounts from the start with no top spacer", () => {
    const length = 200;
    const offsets = offsetsFromHeights(heightsOf(length), length);
    const viewportHeight = 10;
    const win = visibleTranscriptWindow({
      length,
      offsets,
      scrollTop: 0,
      viewportHeight,
      sticky: false,
    });
    expect(win.start).toBe(0);
    expect(win.topSpacer).toBe(0);
    expect(win.end).toBe(viewportHeight + OVERSCAN_ROWS);
    expect(win.bottomSpacer).toBe(length - win.end);
  });

  // App's first layout frame reports scrollTop=0 even while sticky is still true.
  // Treating that as Home would mount the oldest rows and leave the tail in the
  // bottom spacer — follow-tail would show blank. Sticky must win.
  test("sticky with scrollTop 0 still tail-walks, not Home", () => {
    const length = 80;
    const offsets = offsetsFromHeights(heightsOf(length), length);
    const sticky = visibleTranscriptWindow({
      length,
      offsets,
      scrollTop: 0,
      viewportHeight: 10,
      sticky: true,
    });
    const home = visibleTranscriptWindow({
      length,
      offsets,
      scrollTop: 0,
      viewportHeight: 10,
      sticky: false,
    });
    expect(sticky.end).toBe(length);
    expect(sticky.start).toBeGreaterThan(home.start);
    expect(home.start).toBe(0);
  });

  test("mid-scroll range covers the item containing scrollTop", () => {
    const length = 100;
    const offsets = offsetsFromHeights(heightsOf(length), length);
    const scrollTop = 50;
    const viewportHeight = 10;
    const win = visibleTranscriptWindow({
      length,
      offsets,
      scrollTop,
      viewportHeight,
      sticky: false,
    });
    expect(win.start).toBe(scrollTop - OVERSCAN_ROWS);
    expect(win.end).toBe(scrollTop + viewportHeight + OVERSCAN_ROWS);
    expect(win.topSpacer).toBe(win.start);
    expect(win.bottomSpacer).toBe(length - win.end);
  });

  test("cold start (viewportHeight 0) sticky mounts the last COLD_START_COUNT", () => {
    const length = 80;
    const offsets = offsetsFromHeights(heightsOf(length), length);
    const win = visibleTranscriptWindow({
      length,
      offsets,
      scrollTop: 0,
      viewportHeight: 0,
      sticky: true,
    });
    expect(win.end).toBe(length);
    expect(win.start).toBe(length - COLD_START_COUNT);
    expect(win.bottomSpacer).toBe(0);
  });

  // Negative control, recorded rather than executed: feeding the scrollbox
  // `transcript.slice(start, end)` with both spacers at 0 collapses
  // `content.height` to the mounted slice. Home then sets scrollTop=0 onto
  // that short content, so the frame shows the old tail sitting at the new
  // top and the App.test.tsx `line 0` assertions fail. Spacers are what
  // keep a mount window from shrinking scrollHeight.
});
