import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glob } from "../../src/tools/glob";
import { MAX_FILE_RESULTS } from "../../src/tools/runRipgrep";

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

  test("still resolves normally with the `--` separator in the argument list", () => {
    // grep's own `--` is covered by a flag-shaped pattern; glob has no pattern of its own, so
    // this only guards that adding the separator did not break rg's argument parsing.
    const { files } = glob("*.js", { path: tmpDir });

    expect(files).toHaveLength(1);
    expect(files[0].endsWith("c.js")).toBe(true);
  });

  test("caps the results and flags truncation when more files match than the cap", () => {
    for (let i = 0; i < MAX_FILE_RESULTS + 50; i++) writeFileSync(join(tmpDir, `f${i}.md`), "x");

    const { files, truncated } = glob("*.md", { path: tmpDir });

    expect(files).toHaveLength(MAX_FILE_RESULTS);
    expect(truncated).toBe(true);
  });
});
