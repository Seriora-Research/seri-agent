import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grep } from "../../src/tools/grep";
import { MAX_FILE_RESULTS, MAX_RESULTS } from "../../src/tools/runRipgrep";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "seri-grep-test-"));
  writeFileSync(join(tmpDir, "a.txt"), "hello world\nfoo bar\nhello again\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("grep (default mode)", () => {
  test("returns only the names of matching files, not their lines", () => {
    writeFileSync(join(tmpDir, "b.txt"), "hello from b\n");
    writeFileSync(join(tmpDir, "c.txt"), "nothing here\n");

    const result = grep("hello", { path: tmpDir });

    expect(result.mode).toBe("files_with_matches");
    expect(result.files).toHaveLength(2);
    expect(result.files?.every((file) => file.endsWith(".txt"))).toBe(true);
    expect(result.files?.some((file) => file.endsWith("c.txt"))).toBe(false);
    // The whole point of the default: no line text is carried back.
    expect(result.matches).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  test("returns no files when nothing matches", () => {
    const result = grep("nomatchxyz", { path: tmpDir });

    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test("searches for a pattern that looks like a flag instead of letting rg parse it", () => {
    // Without a `--` separator rg reads "--force" as an unrecognized flag, exits 2, and the
    // model gets a thrown error instead of the match it asked for.
    writeFileSync(join(tmpDir, "flag.txt"), "run it with --force here\n");

    const result = grep("--force", { path: tmpDir });

    expect(result.files).toHaveLength(1);
    expect(result.files?.[0].endsWith("flag.txt")).toBe(true);
  });

  test("caps file names at the file limit, which is higher than the match limit", () => {
    for (let i = 0; i < MAX_FILE_RESULTS + 20; i++) writeFileSync(join(tmpDir, `f${i}.md`), "needle\n");

    const result = grep("needle", { path: tmpDir });

    expect(result.files).toHaveLength(MAX_FILE_RESULTS);
    expect(result.truncated).toBe(true);
  });
});

describe("grep (content mode)", () => {
  test("finds a known pattern, returns correct file/line/text", () => {
    const result = grep("hello", { path: tmpDir, mode: "content" });

    expect(result.mode).toBe("content");
    expect(result.matches).toHaveLength(2);
    expect(result.matches?.[0].file).toContain("a.txt");
    expect(result.matches?.[0].line).toBe(1);
    expect(result.matches?.[0].text).toBe("hello world");
    expect(result.matches?.[1].line).toBe(3);
    expect(result.matches?.[1].text).toBe("hello again");
    expect(result.files).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  test("caps the results and flags truncation when there are more matches than the cap", () => {
    writeFileSync(join(tmpDir, "many.txt"), "needle\n".repeat(MAX_RESULTS + 50));

    const result = grep("needle", { path: tmpDir, mode: "content" });

    expect(result.matches).toHaveLength(MAX_RESULTS);
    expect(result.truncated).toBe(true);
  });

  test("does not flag truncation when the matches land exactly on the cap", () => {
    writeFileSync(join(tmpDir, "exact.txt"), "needle\n".repeat(MAX_RESULTS));

    const result = grep("needle", { path: tmpDir, mode: "content" });

    expect(result.matches).toHaveLength(MAX_RESULTS);
    expect(result.truncated).toBe(false);
  });

  test("survives a line that is not valid UTF-8, and still returns the other files' matches", () => {
    // rg emits base64 `bytes` instead of `text` for anything that is not valid UTF-8. Reading
    // `.text` unconditionally threw here and lost every match in the tree, not just this one.
    // 0xE9 is 'é' in latin-1 and is invalid on its own in UTF-8.
    writeFileSync(join(tmpDir, "latin1.txt"), Buffer.concat([Buffer.from("needle caf"), Buffer.from([0xe9]), Buffer.from(" x\n")]));
    writeFileSync(join(tmpDir, "clean.txt"), "needle plain ascii\n");

    const result = grep("needle", { path: tmpDir, mode: "content" });

    expect(result.matches).toHaveLength(2);
    expect(result.matches?.some((match) => match.file.endsWith("clean.txt"))).toBe(true);
    expect(result.matches?.some((match) => match.file.endsWith("latin1.txt"))).toBe(true);
    expect(result.truncated).toBe(false);
  });

  test("returns a capped page instead of throwing when rg outruns the stdout buffer", () => {
    // The bug this tool shipped with: a broad pattern over a large tree threw
    // `rg exited with code null:` and lost every match rg had already found.
    writeFileSync(join(tmpDir, "big.txt"), "needle here on this line\n".repeat(60_000));

    const result = grep("needle", { path: tmpDir, mode: "content" });

    expect(result.matches).toHaveLength(MAX_RESULTS);
    expect(result.truncated).toBe(true);
    // The buffer cuts mid-line, so the partial trailing event must not reach JSON.parse.
    expect(result.matches?.every((match) => match.text === "needle here on this line")).toBe(true);
  });
});

describe("grep (count mode)", () => {
  test("returns per-file totals without carrying any line text", () => {
    writeFileSync(join(tmpDir, "b.txt"), "hello once\n");

    const result = grep("hello", { path: tmpDir, mode: "count" });

    expect(result.mode).toBe("count");
    expect(result.counts).toHaveLength(2);
    expect(result.counts?.find((entry) => entry.file.endsWith("a.txt"))?.count).toBe(2);
    expect(result.counts?.find((entry) => entry.file.endsWith("b.txt"))?.count).toBe(1);
    expect(result.matches).toBeUndefined();
  });

  test("splits the path from the count on the right, so a Windows drive letter survives", () => {
    // rg prints `path:count`, and an absolute Windows path already contains a colon of its own.
    const result = grep("hello", { path: tmpDir, mode: "count" });

    expect(result.counts).toHaveLength(1);
    expect(result.counts?.[0].file.endsWith("a.txt")).toBe(true);
    expect(result.counts?.[0].count).toBe(2);
  });

  test("still names the file when the path is a single file rather than a directory", () => {
    // rg drops the filename prefix when handed exactly one file and prints a bare count, so
    // without --with-filename the parser returned a fragment of the digits as the file name.
    const result = grep("hello", { path: join(tmpDir, "a.txt"), mode: "count" });

    expect(result.counts).toHaveLength(1);
    expect(result.counts?.[0].file.endsWith("a.txt")).toBe(true);
    expect(result.counts?.[0].count).toBe(2);
  });
});
