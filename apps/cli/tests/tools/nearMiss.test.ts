import { describe, expect, test } from "bun:test";
import { edit } from "../../src/tools/edit";
import { describeNearMiss } from "../../src/tools/nearMiss";

describe("describeNearMiss", () => {
  test("names the LATER differing line when the first line of a multi-line oldString matches", () => {
    const content = [
      "export function getApiKey(name) {",
      "  const config = loadConfig();",
      "  return config[name];",
      "}",
    ].join("\n");
    const report = describeNearMiss(
      content,
      [
        "export function getApiKey(name) {",
        "  const config = readConfig();",
        "  return config[name];",
        "}",
      ].join("\n"),
    );

    expect(report).toContain("line 2");
    expect(report).toContain("const config = loadConfig();");
    expect(report).toContain("const config = readConfig();");
    expect(report).not.toContain("line 1");
  });

  test("picks the window with the most matching lines, not the first window that matches at all", () => {
    const content = ["const a = 1;", "if (x) {", "  go();", "}", "if (y) {", "  stop();", "}"].join(
      "\n",
    );
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

  test("a window carried by a lone closing brace is refused, not reported as a near miss", () => {
    const content = [
      "export function handler(req: Request) {",
      "  const token = req.headers.get('authorization');",
      "  if (!token) return unauthorized();",
      "  return ok(token);",
      "}",
    ].join("\n");
    const report = describeNearMiss(
      content,
      [
        "  const session = await loadSession(req);",
        "  if (!session) return redirect('/login');",
        "}",
      ].join("\n"),
    );

    expect(report).toBeNull();
  });

  test("stage 2 never names a line that exactly matches the probe", () => {
    const content = [
      "function a() {",
      "  return 1;",
      "}",
      "",
      "function b() {",
      "  return 2;",
      "}",
    ].join("\n");
    const report = describeNearMiss(content, ["}", "const totallyUnrelated = 9;"].join("\n"));

    expect(report).toBeNull();
  });

  test("a window carried only by `});` is refused, exactly as a lone brace is", () => {
    const content = [
      "app.get('/session', async (req: Request) => {",
      "  const token = req.headers.get('authorization');",
      "  if (!token) return unauthorized();",
      "  return ok(token);",
      "});",
    ].join("\n");
    const report = describeNearMiss(
      content,
      [
        "  const session = await loadSession(req);",
        "  if (!session) return redirect('/login');",
        "});",
      ].join("\n"),
    );

    expect(report).toBeNull();
  });

  test("a line that repeats in the content cannot qualify a window on its own", () => {
    const content = [
      "const a = 1;",
      "return;",
      "const b = 2;",
      "return;",
      "const c = 3;",
      "return;",
    ].join("\n");
    const report = describeNearMiss(content, ["totallyDifferentThing();", "return;"].join("\n"));

    expect(report).toBeNull();
  });

  test("nothing in the content trim-matches any line, so no line is named", () => {
    const content = "const a = 1;\nconst b = 2;\n";
    expect(
      describeNearMiss(content, "export default function Widget(props) {\n  return null;\n}"),
    ).toBeNull();
  });

  test("a single-line oldString off by one character names the right line and shows both texts", () => {
    const content = "function total(a, b) {\n  const sum = a + b;\n  return sum;\n}\n";
    const report = describeNearMiss(content, "  const sum = a - b;");

    expect(report).not.toBeNull();
    expect(report).toContain("line 2");
    expect(report).toContain("const sum = a + b;");
    expect(report).toContain("const sum = a - b;");
  });

  test("a multi-line oldString with nothing trim-matching still names the closest line", () => {
    const content = "function total(a, b) {\n  const sum = a + b;\n  return sum;\n}\n";
    const report = describeNearMiss(content, "  const sum = a - b;\n  return total;");

    expect(report).not.toBeNull();
    expect(report).toContain("line 2");
    expect(report).toContain("const sum = a + b;");
  });

  test("an oldString longer than the content yields null rather than reading past the end", () => {
    expect(describeNearMiss("const a = 1;\n", "a\nb\nc\nd\ne")).toBeNull();
  });
});

describe("edit's no-match failure message", () => {
  const content = [
    "export function getApiKey(name) {",
    "  const config = loadConfig();",
    "  return config[name];",
    "}",
  ].join("\n");
  const searched = [
    "export function getApiKey(name) {",
    "  const config = readConfig();",
    "  return config[name];",
    "}",
  ].join("\n");

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
