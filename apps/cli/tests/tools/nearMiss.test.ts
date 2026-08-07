import { describe, expect, test } from "bun:test";
import { edit } from "../../src/tools/edit";
import { describeNearMiss } from "../../src/tools/nearMiss";

describe("describeNearMiss", () => {
  // The case whose absence hid the defect this reframe fixes. `tryLineTrimmedMatch` (edit.ts:28-60)
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

  // Window selection, not first-hit: the window starting at line 5 scores 2 trim-matching lines
  // ("if (y) {" and "}"), while the earlier one starting at line 2 scores 1 (its "}" alone).
  // Taking the first window that matched anything at all would name line 2.
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

  // A window is selected on "at least one line trim-matched", and a lone `}` clears that. Without
  // a quality floor on the pair actually printed, the report then asserts two entirely unrelated
  // lines as a near miss — the same degenerate-probe class the similarity floor exists to stop,
  // just reached through stage 1 instead of stage 2. Realistic: a model misremembering a block it
  // is editing lines up the closing brace and nothing else.
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
      ["  const session = await loadSession(req);", "  if (!session) return redirect('/login');", "}"].join("\n"),
    );

    expect(report).toBeNull();
  });

  // Stage 2 scores oldString's first non-blank line against every content line, so when that probe
  // is a lone `}` some brace in the file scores 1.0 and the report prints identical `actual` and
  // `searched` — the H2 symptom arriving from the other side. An exact match is not a near miss.
  test("stage 2 never names a line that exactly matches the probe", () => {
    const content = ["function a() {", "  return 1;", "}", "", "function b() {", "  return 2;", "}"].join("\n");
    const report = describeNearMiss(content, ["}", "const totallyUnrelated = 9;"].join("\n"));

    expect(report).toBeNull();
  });

  // The same class as the lone `}` above, and the reason the test is "no alphanumeric character"
  // rather than a length: `});` is three characters and the most common closer in JS/TS, so any
  // length cut that admits it admits the hole, and any cut that excludes it moves the hole to
  // `}));` and `],`. What disqualifies all of them is that they are pure punctuation — they occur
  // everywhere and identify no position.
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
      ["  const session = await loadSession(req);", "  if (!session) return redirect('/login');", "});"].join("\n"),
    );

    expect(report).toBeNull();
  });

  // The other half of patience diff's rule, and the half a punctuation test cannot express:
  // `return;` has identifiers, but occurring three times it says nothing about WHICH window is the
  // right one. Frequency, not character class, is what makes a line a usable anchor.
  test("a line that repeats in the content cannot qualify a window on its own", () => {
    const content = ["const a = 1;", "return;", "const b = 2;", "return;", "const c = 3;", "return;"].join("\n");
    const report = describeNearMiss(content, ["totallyDifferentThing();", "return;"].join("\n"));

    expect(report).toBeNull();
  });

  test("nothing in the content trim-matches any line, so no line is named", () => {
    const content = "const a = 1;\nconst b = 2;\n";
    expect(describeNearMiss(content, "export default function Widget(props) {\n  return null;\n}")).toBeNull();
  });

  // The case window scoring alone cannot serve, and the most common edit shape there is. A
  // one-line oldString can never score in a window: if a content line trim-matched it, tier 1
  // would have replaced it, so `edit` never reaches here with one. The character-similarity
  // fallback is what covers it — and knowing what you searched for is not knowing what is
  // actually there, which is the whole point of the report.
  test("a single-line oldString off by one character names the right line and shows both texts", () => {
    const content = "function total(a, b) {\n  const sum = a + b;\n  return sum;\n}\n";
    const report = describeNearMiss(content, "  const sum = a - b;");

    expect(report).not.toBeNull();
    expect(report).toContain("line 2");
    expect(report).toContain("const sum = a + b;");
    expect(report).toContain("const sum = a - b;");
  });

  // The same fallback, reached from a MULTI-line oldString where no line trim-matches anywhere.
  // Window scoring alone returns null here even though line 2 is one character away.
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
