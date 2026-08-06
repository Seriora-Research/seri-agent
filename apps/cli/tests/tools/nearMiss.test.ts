import { describe, expect, test } from "bun:test";
import { edit } from "../../src/tools/edit";
import { describeNearMiss } from "../../src/tools/nearMiss";

describe("describeNearMiss", () => {
  // The case whose absence hid the defect this reframe fixes. `tryLineTrimmedMatch` (edit.ts:26-58)
  // already trim-matches EVERY line, so a failure that survives the cascade with a correct first
  // line means a LATER line differs — the dominant real case. Naming line 1 here would name the one
  // line the model got right; measured on the first implementation, it did exactly that and printed
  // the same string as both `actual` and `searched`.
  test("names the LATER differing line when the first line of a multi-line oldString matches", () => {
    const content = ["export function getApiKey(name) {", "  const config = loadConfig();", "  return config[name];", "}"].join("\n");
    const report = describeNearMiss(
      content,
      ["export function getApiKey(name) {", "  const config = readConfig();", "  return config[name];", "}"].join("\n"),
    );

    expect(report).toContain("line 2");
    expect(report).toContain("const config = loadConfig();");
    expect(report).toContain("const config = readConfig();");
    expect(report).not.toContain("line 1");
  });

  // Window selection, not first-hit: the window at line 5 scores 2 trim-matching lines, the one at
  // line 2 scores 1. Picking the first window with any match at all would name line 4.
  test("picks the window with the most matching lines, not the first window that matches at all", () => {
    const content = ["const a = 1;", "if (x) {", "  go();", "}", "if (y) {", "  stop();", "}"].join("\n");
    const report = describeNearMiss(content, ["if (y) {", "  halt();", "}"].join("\n"));

    expect(report).toContain("line 6");
    expect(report).toContain("stop();");
    expect(report).toContain("halt();");
  });

  test("reports the differing line even when it is the last line of the window", () => {
    const content = ["try {", "  run();", "} catch (err) {", "  log(err);", "}"].join("\n");
    const report = describeNearMiss(content, ["} catch (err) {", "  report(err);"].join("\n"));

    expect(report).toContain("line 4");
    expect(report).toContain("log(err);");
  });

  test("nothing in the content trim-matches any line, so no line is named", () => {
    const content = "const a = 1;\nconst b = 2;\n";
    expect(describeNearMiss(content, "export default function Widget(props) {\n  return null;\n}")).toBeNull();
  });

  // The narrowing this design accepts, pinned so it is a decision rather than a surprise: one
  // content line trim-matching a one-line oldString is exactly what tier 1 replaces, so `edit`
  // never reaches this function with a single-line near miss to describe.
  test("a single-line oldString yields null, because no single-line window can score", () => {
    const content = "function total(a, b) {\n  const sum = a + b;\n  return sum;\n}\n";
    expect(describeNearMiss(content, "  const sum = a - b;")).toBeNull();
  });

  test("an oldString longer than the content yields null rather than reading past the end", () => {
    expect(describeNearMiss("const a = 1;\n", "a\nb\nc\nd\ne")).toBeNull();
  });
});

// The tool-result half of the same behaviour. `edit` throws, the loop turns the throw into an
// `error-text` tool result (loop.ts:339-346), so what the model reads is exactly this message.
describe("edit's no-match failure message", () => {
  const content = ["export function getApiKey(name) {", "  const config = loadConfig();", "  return config[name];", "}"].join("\n");
  const searched = ["export function getApiKey(name) {", "  const config = readConfig();", "  return config[name];", "}"].join("\n");

  test("carries the near-miss report: the candidate's line number, its actual text, and the searched text", () => {
    expect(() => edit(content, searched, "x")).toThrow(/line 2/);
    expect(() => edit(content, searched, "x")).toThrow(/const config = loadConfig\(\);/);
    expect(() => edit(content, searched, "x")).toThrow(/const config = readConfig\(\);/);
  });

  test("degrades to today's bare wording when no line can be named", () => {
    let message = "";
    try {
      edit("const a = 1;\n", "export default function Widget(props) {\n  return null;\n}", "x");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toBe(
      "Could not find the specified text to replace (tried exact, line-trimmed, and whitespace-normalized matching)",
    );
  });
});
