import { describe, expect, test } from "bun:test";
import { edit } from "../../src/tools/edit";

describe("edit", () => {
  test("tier 0 (exact match) succeeds directly", () => {
    const content = "function foo() {\n  return 1;\n}\n";
    const result = edit(content, "return 1;", "return 2;");
    expect(result).toBe("function foo() {\n  return 2;\n}\n");
  });

  test("tier 1 (line-trimmed) succeeds when tier 0 fails due to indentation differences", () => {
    const content = "function foo() {\n    return 1;\n}\n";
    const oldString = "  return 1;\n  }"; // different indentation than content
    const newString = "return 42;\n}";
    const result = edit(content, oldString, newString);
    expect(result).toBe("function foo() {\nreturn 42;\n}\n");
  });

  test("tier 2 (whitespace-normalized) succeeds when tier 0 and tier 1 both fail", () => {
    const content = "start\nconst  x  =  5;\nend\n";
    const oldString = "const x = 5;"; // single spaces vs content's double spaces, same line
    const newString = "const x = 10;";
    const result = edit(content, oldString, newString);
    expect(result).toBe("start\nconst x = 10;\nend\n");
  });

  test("ambiguity guard throws when oldString matches multiple times (does not fall through)", () => {
    const content = "const a = 1;\nconst a = 1;\n";
    const oldString = "const a = 1;";
    expect(() => edit(content, oldString, "const a = 2;")).toThrow(/matched multiple times/);
  });

  test("disproportionate-match guard throws when a whitespace-normalized match spans a huge unrelated block", () => {
    const content = `a${" ".repeat(1000)}b`;
    const oldString = "a    b";
    expect(() => edit(content, oldString, "ab")).toThrow(/disproportionately larger/);
  });

  test("throws a clear error when oldString is not found by any tier", () => {
    const content = "const a = 1;\n";
    const oldString = "const b = 2;";
    expect(() => edit(content, oldString, "const c = 3;")).toThrow(
      "Could not find the specified text to replace (tried exact, line-trimmed, and whitespace-normalized matching)",
    );
  });

  test("whitespace-normalized uniqueness throw names the whitespace-normalized tier", () => {
    const content = "const  x  =  1;\nconst  x  =  1;\n";
    const oldString = "const x = 1;";
    expect(() => edit(content, oldString, "const x = 2;")).toThrow(
      "oldString matched multiple times in content (whitespace-normalized match); cannot determine which occurrence to replace",
    );
  });

  test("whitespace-normalized fallback on a large unique file stays well below the per-code-unit baseline", () => {
    // One long line so exact and line-trim misses stay cheap; the bound is the
    // whitespace-normalized scan. Many short lines would spend the budget in tier 1.
    let body = "";
    let i = 0;
    while (body.length < 150_000) {
      body += `t${i}=${i};`;
      i++;
    }
    const content = `${body}const  UNIQUE_MARKER  =  ${i};`;
    const oldString = `const UNIQUE_MARKER = ${i};`;

    edit(content, oldString, "REPLACED;");
    const samples: number[] = [];
    let result = "";
    for (let k = 0; k < 5; k++) {
      const started = performance.now();
      result = edit(content, oldString, "REPLACED;");
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    expect(result.endsWith("REPLACED;")).toBe(true);
    expect(result).not.toContain("UNIQUE_MARKER");
    // Negative control (this fixture, Bun 1.4.0, Linux): per-code-unit `/\s/.test`
    // plus three growable arrays timed 4.2 ms median. Bound is 3 ms so that path
    // fails and the compact-run scan's warmed median (~0.1 ms here) passes.
    expect(samples[2]).toBeLessThan(3);
  });
});
