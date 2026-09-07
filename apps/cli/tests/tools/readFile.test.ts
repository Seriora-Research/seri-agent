import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "../../src/tools/readFile";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-readFile-test-"));
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

  test("returns a file that lands exactly on 30000 characters whole", () => {
    const filePath = join(tmpRoot, "cap.txt");
    writeFileSync(filePath, "x".repeat(30_000));
    const result = readFile(filePath);
    expect(result).toHaveLength(30_000);
    expect(result).not.toContain("characters omitted");
  });

  test("caps an oversized file, keeps both ends, and omits the middle", () => {
    const filePath = join(tmpRoot, "big.txt");
    writeFileSync(filePath, "A".repeat(100_000) + "B".repeat(100_000));
    const result = readFile(filePath);
    expect(result.length).toBeLessThan(30_200);
    expect(result.startsWith("A".repeat(100))).toBe(true);
    expect(result.endsWith("B".repeat(100))).toBe(true);
    expect(result).toContain("characters omitted");
  });

  test("does not strand half a surrogate pair when the cut lands inside one", () => {
    const filePath = join(tmpRoot, "emoji-head.txt");
    writeFileSync(filePath, `x${"\u{1F600}".repeat(20_000)}`);
    const result = readFile(filePath);
    expect(result).toContain("characters omitted");
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
    expect(result).not.toContain("�");
  });

  test("does not strand half a pair at the front of the tail either", () => {
    const filePath = join(tmpRoot, "emoji-tail.txt");
    writeFileSync(filePath, `x${"\u{1F600}".repeat(20_000)}y`);
    const result = readFile(filePath);
    expect(result).toContain("characters omitted");
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
    expect(result).not.toContain("�");
  });
});
