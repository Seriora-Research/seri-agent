import { describe, expect, test } from "bun:test";
import { describeNearMiss } from "../../src/verify/nearMiss";

describe("describeNearMiss", () => {
  test("a one-character-off oldString reports the line number, the actual text and the searched text", () => {
    const content = "function total(a, b) {\n  const sum = a + b;\n  return sum;\n}\n";
    const report = describeNearMiss(content, "  const sum = a - b;");

    expect(report).not.toBeNull();
    expect(report).toContain("line 2");
    expect(report).toContain("const sum = a + b;");
    expect(report).toContain("const sum = a - b;");
  });

  test("reports the nearest line when several are close, not merely the first", () => {
    const content = "const alpha = 1;\nconst bravo = 2;\nconst charlie = 3;\n";
    const report = describeNearMiss(content, "const charlie = 4;");

    expect(report).toContain("line 3");
    expect(report).toContain("const charlie = 3;");
  });

  test("uses the first non-blank line of a multi-line oldString as the probe", () => {
    const content = "a\nb\n  if (ready) {\n    go();\n  }\n";
    const report = describeNearMiss(content, "\n  if (readyy) {\n    go();\n  }");

    expect(report).toContain("line 3");
    expect(report).toContain("if (ready) {");
  });

  // The complement of the test above, and the reason the threshold exists: without it every
  // failed edit would name some arbitrary line as "the closest", which is a confident wrong
  // answer rather than an absent one.
  test("nothing similar in the content yields null", () => {
    const content = "const a = 1;\nconst b = 2;\n";
    expect(describeNearMiss(content, "export default function Widget(props) {")).toBeNull();
  });

  test("an all-blank oldString yields null rather than matching a blank line", () => {
    expect(describeNearMiss("const a = 1;\n", "   \n\n")).toBeNull();
  });
});
