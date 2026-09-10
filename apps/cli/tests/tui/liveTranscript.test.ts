import { describe, expect, test } from "bun:test";
import { capLiveTranscript } from "../../src/tui/util/liveTranscript";
import type { TranscriptEntry } from "../../src/tui/util/format";

function e(text: string): TranscriptEntry {
  return { role: "system", text };
}

describe("capLiveTranscript", () => {
  test("keeps the same array when already under or at the cap", () => {
    const under = [e("a"), e("b")];
    expect(capLiveTranscript(under, 3)).toBe(under);
    const exact = [e("a"), e("b"), e("c")];
    expect(capLiveTranscript(exact, 3)).toBe(exact);
  });

  test("keeps the tail and the same objects", () => {
    const rows = [e("a"), e("b"), e("c"), e("d")];
    const capped = capLiveTranscript(rows, 2);
    expect(capped).toEqual([e("c"), e("d")]);
    expect(capped[0]).toBe(rows[2]);
    expect(capped[1]).toBe(rows[3]);
    expect(capLiveTranscript(rows, 4)).toBe(rows);
  });
});
