import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grep } from "../../src/tools/grep";
import { MAX_RESULTS } from "../../src/tools/runRipgrep";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hesper-grep-test-"));
  writeFileSync(join(tmpDir, "a.txt"), "hello world\nfoo bar\nhello again\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("grep", () => {
  test("finds a known pattern, returns correct file/line/text", () => {
    const { matches, truncated } = grep("hello", { path: tmpDir });
    expect(matches).toHaveLength(2);
    expect(matches[0].file).toContain("a.txt");
    expect(matches[0].line).toBe(1);
    expect(matches[0].text).toBe("hello world");
    expect(matches[1].line).toBe(3);
    expect(matches[1].text).toBe("hello again");
    expect(truncated).toBe(false);
  });

  test("returns [] for no matches", () => {
    expect(grep("nomatchxyz", { path: tmpDir })).toEqual({ matches: [], truncated: false });
  });

  test("caps the results and flags truncation when there are more matches than the cap", () => {
    writeFileSync(join(tmpDir, "many.txt"), "needle\n".repeat(MAX_RESULTS + 50));

    const { matches, truncated } = grep("needle", { path: tmpDir });

    expect(matches).toHaveLength(MAX_RESULTS);
    expect(truncated).toBe(true);
  });

  test("does not flag truncation when the matches land exactly on the cap", () => {
    writeFileSync(join(tmpDir, "exact.txt"), "needle\n".repeat(MAX_RESULTS));

    const { matches, truncated } = grep("needle", { path: tmpDir });

    expect(matches).toHaveLength(MAX_RESULTS);
    expect(truncated).toBe(false);
  });

  test("survives a line that is not valid UTF-8, and still returns the other files' matches", () => {
    // rg emits base64 `bytes` instead of `text` for anything that is not valid UTF-8. Reading
    // `.text` unconditionally threw here and lost every match in the tree, not just this one.
    // 0xE9 is 'é' in latin-1 and is invalid on its own in UTF-8.
    writeFileSync(join(tmpDir, "latin1.txt"), Buffer.concat([Buffer.from("needle caf"), Buffer.from([0xe9]), Buffer.from(" x\n")]));
    writeFileSync(join(tmpDir, "clean.txt"), "needle plain ascii\n");

    const { matches, truncated } = grep("needle", { path: tmpDir });

    expect(matches).toHaveLength(2);
    expect(matches.some((match) => match.file.endsWith("clean.txt"))).toBe(true);
    expect(matches.some((match) => match.file.endsWith("latin1.txt"))).toBe(true);
    expect(truncated).toBe(false);
  });

  test("returns a capped page instead of throwing when rg outruns the stdout buffer", () => {
    // The bug this tool shipped with: a broad pattern over a large tree threw
    // `rg exited with code null:` and lost every match rg had already found.
    writeFileSync(join(tmpDir, "big.txt"), "needle here on this line\n".repeat(60_000));

    const { matches, truncated } = grep("needle", { path: tmpDir });

    expect(matches).toHaveLength(MAX_RESULTS);
    expect(truncated).toBe(true);
    // The buffer cuts mid-line, so the partial trailing event must not reach JSON.parse.
    expect(matches.every((match) => match.text === "needle here on this line")).toBe(true);
  });
});
