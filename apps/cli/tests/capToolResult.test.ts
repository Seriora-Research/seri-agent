import { describe, expect, test } from "bun:test";
import { capToolResult, MAX_TOOL_RESULT_CHARS } from "../src/capToolResult";

describe("capToolResult", () => {
  test("leaves text at or under the cap untouched", () => {
    expect(capToolResult("hello")).toBe("hello");
    expect(capToolResult("x".repeat(MAX_TOOL_RESULT_CHARS))).toHaveLength(MAX_TOOL_RESULT_CHARS);
    expect(capToolResult("x".repeat(MAX_TOOL_RESULT_CHARS))).not.toContain("characters omitted");
  });

  test("keeps both ends of oversized text and names how many characters dropped", () => {
    const text = `A${"x".repeat(40_000)}B`;
    const result = capToolResult(text);
    expect(result.length).toBeLessThan(30_200);
    expect(result.startsWith("A")).toBe(true);
    expect(result.endsWith("B")).toBe(true);
    expect(result).toContain(`[${text.length - 30_000} characters omitted]`);
  });

  test("does not flag a truncation when a surrogate pair sits on the exact-cap seam", () => {
    const text = `x${"\u{1F600}".repeat(14_999)}y`;
    expect(text).toHaveLength(MAX_TOOL_RESULT_CHARS);
    const result = capToolResult(text);
    expect(result).toBe(text);
    expect(result).not.toContain("characters omitted");
  });

  test("does not strand half a surrogate pair at either cut", () => {
    const head = capToolResult(`x${"\u{1F600}".repeat(20_000)}`);
    expect(Buffer.from(head, "utf8").toString("utf8")).toBe(head);
    expect(head).not.toContain("�");

    const tail = capToolResult(`x${"\u{1F600}".repeat(20_000)}y`);
    expect(Buffer.from(tail, "utf8").toString("utf8")).toBe(tail);
    expect(tail).not.toContain("�");
  });
});
