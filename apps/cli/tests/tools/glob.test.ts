import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glob } from "../../src/tools/glob";
import { MAX_RESULTS } from "../../src/tools/runRipgrep";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hesper-glob-test-"));
  writeFileSync(join(tmpDir, "a.txt"), "a");
  writeFileSync(join(tmpDir, "b.txt"), "b");
  writeFileSync(join(tmpDir, "c.js"), "c");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("glob", () => {
  test("matches a known fixture set by extension pattern", () => {
    const { files, truncated } = glob("*.txt", { path: tmpDir });
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.endsWith(".txt"))).toBe(true);
    expect(truncated).toBe(false);
  });

  test("caps the results and flags truncation when more files match than the cap", () => {
    for (let i = 0; i < MAX_RESULTS + 50; i++) writeFileSync(join(tmpDir, `f${i}.md`), "x");

    const { files, truncated } = glob("*.md", { path: tmpDir });

    expect(files).toHaveLength(MAX_RESULTS);
    expect(truncated).toBe(true);
  });
});
