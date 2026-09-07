import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../src/atomicWriteFile";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("atomicWriteFile", () => {
  test("writes the file and leaves no tmp file behind", () => {
    dir = mkdtempSync(join(tmpdir(), "seri-atomic-"));
    const target = join(dir, "sub", "MEMORY.md");
    atomicWriteFile(target, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(readdirSync(join(dir, "sub"))).toEqual(["MEMORY.md"]);
  });







  test("two interleaved writes to the same path never see each other's tmp file", () => {
    dir = mkdtempSync(join(tmpdir(), "seri-atomic-"));
    const target = join(dir, "MEMORY.md");
    atomicWriteFile(target, "first");
    atomicWriteFile(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
    expect(readdirSync(dir)).toEqual(["MEMORY.md"]);
  });







  test("sweeps a stale tmp file left behind by a dead process before writing", () => {
    dir = mkdtempSync(join(tmpdir(), "seri-atomic-"));
    const target = join(dir, "MEMORY.md");
    const stalePath = `${target}.999999999.deadbeef.tmp`;
    writeFileSync(stalePath, "orphaned content");

    atomicWriteFile(target, "hello");

    expect(existsSync(stalePath)).toBe(false);
    expect(readdirSync(dir)).toEqual(["MEMORY.md"]);
  });






  test("does not sweep a tmp file whose encoded pid is still alive", () => {
    dir = mkdtempSync(join(tmpdir(), "seri-atomic-"));
    const target = join(dir, "MEMORY.md");
    const liveTmpPath = `${target}.${process.pid}.cafebabe.tmp`;
    writeFileSync(liveTmpPath, "still being written");

    atomicWriteFile(target, "hello");

    expect(existsSync(liveTmpPath)).toBe(true);
    expect(readFileSync(liveTmpPath, "utf8")).toBe("still being written");
    expect(readFileSync(target, "utf8")).toBe("hello");
  });
});
