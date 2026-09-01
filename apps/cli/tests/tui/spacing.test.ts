import { describe, expect, test } from "bun:test";
import { gapBefore, hairlineRow } from "../../src/tui/theme/spacing";
import type { TranscriptRole } from "../../src/tui/util/format";

const ROLES: TranscriptRole[] = ["user", "assistant", "system"];

// Transcribed by hand rather than read off GAP_TABLE, so a change to the lookup has to be made
// deliberately in both places instead of silently agreeing with itself.
const TABLE: [TranscriptRole | undefined, Record<TranscriptRole, 0 | 1>][] = [
  [undefined, { user: 0, assistant: 0, system: 0 }],
  ["user", { user: 1, assistant: 1, system: 1 }],
  ["assistant", { user: 1, assistant: 0, system: 0 }],
  ["system", { user: 1, assistant: 0, system: 0 }],
];

describe("hairlineRow", () => {
  test("is a mark of ─, one per column", () => {
    expect(hairlineRow(4)).toBe("────");
  });

  test("empty at zero columns, never negative", () => {
    expect(hairlineRow(0)).toBe("");
    expect(hairlineRow(-2)).toBe("");
  });
});

describe("gapBefore", () => {
  for (const [prev, row] of TABLE) {
    for (const cur of ROLES) {
      test(`${prev ?? "nothing"} then ${cur} is ${row[cur]}`, () => {
        expect(gapBefore(prev, cur)).toBe(row[cur]);
      });
    }
  }
});
