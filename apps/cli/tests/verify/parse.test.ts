import { describe, expect, test } from "bun:test";
import { parseDiagnostics } from "../../src/verify/parse";

describe("parseDiagnostics", () => {
  test("parses tsc-format lines and skips interleaved junk rather than failing on it", () => {
    const text = [
      "$ tsc --noEmit",
      "src/a.ts(12,7): error TS2322: Type 'number' is not assignable to type 'string'.",
      "",
      "some unrelated progress line",
      "src/b.ts(3,1): error TS2304: Cannot find name 'foo'.",
      "error: script \"typecheck\" exited with code 1",
    ].join("\n");

    expect(parseDiagnostics(text)).toEqual([
      {
        file: "src/a.ts",
        line: 12,
        column: 7,
        message: "error TS2322: Type 'number' is not assignable to type 'string'.",
      },
      { file: "src/b.ts", line: 3, column: 1, message: "error TS2304: Cannot find name 'foo'." },
    ]);
  });

  test("parses CRLF output, which is what tsc emits on Windows", () => {
    const text = "src/a.ts(1,1): error TS1005: ';' expected.\r\nsrc/b.ts(2,2): error TS1005: ';' expected.\r\n";
    const parsed = parseDiagnostics(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].message).toBe("error TS1005: ';' expected.");
  });

  // spawnCollect.ts:80 drops the MIDDLE of an oversized stream and rejoins the two halves around a
  // "[N characters omitted]" marker, so the resumed half starts part-way through a line. That
  // fragment and the marker must both drop out without taking their intact neighbours with them.
  test("a line severed by spawnCollect's middle-drop is skipped; the lines around it still parse", () => {
    const head = "src/a.ts(1,1): error TS2322: Type 'number' is not assignable to type 'string'.";
    const tail = "src/z.ts(99,4): error TS2304: Cannot find name 'bar'.";
    const text = [head, "\n... [4210 characters omitted] ...", "s(41,9): error TS2339: Property 'x' does not exi", tail].join("\n");

    expect(parseDiagnostics(text).map((d) => d.file)).toEqual(["src/a.ts", "src/z.ts"]);
  });

  test("output with no diagnostic-shaped line at all yields an empty array", () => {
    expect(parseDiagnostics("Compilation succeeded\n")).toEqual([]);
  });
});
