import { describe, expect, test } from "bun:test";
import {
  capJson,
  classifyEditError,
  summarizeArgs,
  summarizeResult,
} from "../../src/trajectory/summarize";

describe("summarizeArgs", () => {
  test("write_file stores path and byte count, not content", () => {
    const content = "x".repeat(100_000);
    const { value } = summarizeArgs("write_file", { path: "a.ts", content });
    expect(value).toEqual({ path: "a.ts", bytes: 100000 });
    expect(JSON.stringify(value)).not.toContain("xxxx");
  });

  test("edit stores oldBytes and newBytes only", () => {
    const { value } = summarizeArgs("edit", {
      content: "function foo() {}",
      oldString: "aaa",
      newString: "bbbb",
    });
    expect(value).toEqual({ oldBytes: 3, newBytes: 4 });
  });
});

describe("summarizeResult", () => {
  test("read_file stores bytes, not the body", () => {
    const body = "y".repeat(50_000);
    const { value } = summarizeResult("read_file", body);
    expect(value).toEqual({ bytes: 50000 });
    expect(JSON.stringify(value)).not.toContain("yyyy");
  });
});

describe("classifyEditError", () => {
  test("classifies the three edit.ts throw prefixes", () => {
    expect(
      classifyEditError(
        "Could not find the specified text to replace (tried exact, line-trimmed, and whitespace-normalized matching)",
      ),
    ).toBe("near_miss");
    expect(classifyEditError("oldString matched multiple times in content (exact match)")).toBe(
      "ambiguous",
    );
    expect(
      classifyEditError(
        "Matched span (1000 chars) is disproportionately larger than the search text (6 chars); refusing to replace",
      ),
    ).toBe("disproportionate");
  });

  test("unknown strings are error", () => {
    expect(classifyEditError("ENOENT: no such file")).toBe("error");
  });
});

describe("capJson", () => {
  test("elides values whose JSON is over 8192 bytes", () => {
    const big = { blob: "z".repeat(9000) };
    const { value, elided } = capJson(big);
    expect(elided?.elided).toBe(true);
    expect(elided?.originalBytes).toBeGreaterThanOrEqual(8192);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(8192 + 64);
  });
});
