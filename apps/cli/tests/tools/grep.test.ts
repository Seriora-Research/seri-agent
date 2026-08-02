import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grep } from "../../src/tools/grep";

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
    const matches = grep("hello", { path: tmpDir });
    expect(matches).toHaveLength(2);
    expect(matches[0].file).toContain("a.txt");
    expect(matches[0].line).toBe(1);
    expect(matches[0].text).toBe("hello world");
    expect(matches[1].line).toBe(3);
    expect(matches[1].text).toBe("hello again");
  });

  test("returns [] for no matches", () => {
    expect(grep("nomatchxyz", { path: tmpDir })).toEqual([]);
  });
});
