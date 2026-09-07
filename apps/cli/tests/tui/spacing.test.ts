import { describe, expect, test } from "bun:test";
import { gapBefore, hairlineRow } from "../../src/tui/theme/spacing";
import type { TranscriptRole } from "../../src/tui/util/format";

const ROLES: TranscriptRole[] = ["user", "assistant", "system"];

const TABLE: [TranscriptRole | undefined, Record<TranscriptRole, 0 | 1>][] = [
  [undefined, { user: 0, assistant: 0, system: 0 }],
  ["user", { user: 1, assistant: 1, system: 1 }],
  ["assistant", { user: 1, assistant: 0, system: 1 }],
  ["system", { user: 1, assistant: 1, system: 0 }],
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

  test("reasoning stays tight against the answer", () => {
    expect(gapBefore("system", "assistant", "reasoning")).toBe(0);
    expect(gapBefore("assistant", "system", undefined, "reasoning")).toBe(0);
  });

  test("file-change and tool-summary take a blank row", () => {
    expect(gapBefore("system", "system", "file-change")).toBe(1);
    expect(gapBefore("system", "system", undefined, "tool-summary")).toBe(1);
  });
});
