import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "../../src/tools/readFile";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hesper-readFile-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("readFile", () => {
  test("normalizes CRLF line endings to LF", () => {
    const filePath = join(tmpRoot, "crlf.txt");
    writeFileSync(filePath, "line1\r\nline2\r\n");
    expect(readFile(filePath)).toBe("line1\nline2\n");
  });

  test("reads an LF file unchanged", () => {
    const filePath = join(tmpRoot, "lf.txt");
    writeFileSync(filePath, "line1\nline2\n");
    expect(readFile(filePath)).toBe("line1\nline2\n");
  });
});
