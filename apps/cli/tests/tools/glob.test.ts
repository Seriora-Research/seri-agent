import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glob } from "../../src/tools/glob";

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
    const files = glob("*.txt", { path: tmpDir });
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.endsWith(".txt"))).toBe(true);
  });
});
