import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "../../src/tools/writeFile";

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hesper-writeFile-test-"));
});

afterEach(() => {
  setPlatform(originalPlatform);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("writeFile", () => {
  test("atomic write succeeds and file contains the right content", () => {
    const filePath = join(tmpRoot, "out.txt");
    writeFile(filePath, "hello world");
    expect(readFileSync(filePath, "utf8")).toBe("hello world");
  });

  test("preserves an existing CRLF file's line endings", () => {
    const filePath = join(tmpRoot, "crlf.txt");
    writeFileSync(filePath, "old\r\ncontent\r\n");
    writeFile(filePath, "new\ncontent\n");
    expect(readFileSync(filePath, "utf8")).toBe("new\r\ncontent\r\n");
  });

  test("throws when writing to a reserved device name on win32", () => {
    setPlatform("win32");
    const filePath = join(tmpRoot, "CON.txt");
    expect(() => writeFile(filePath, "data")).toThrow();
  });

  test("case collision: Foo.ts and foo.ts", () => {
    const upperPath = join(tmpRoot, "Foo.ts");
    const lowerPath = join(tmpRoot, "foo.ts");
    writeFile(upperPath, "first");
    writeFile(lowerPath, "second");

    if (process.platform === "linux") {
      expect(readFileSync(upperPath, "utf8")).toBe("first");
      expect(readFileSync(lowerPath, "utf8")).toBe("second");
    } else {
      // win32/darwin have case-insensitive filesystems: writing foo.ts overwrites Foo.ts.
      expect(readFileSync(upperPath, "utf8")).toBe("second");
      expect(readFileSync(lowerPath, "utf8")).toBe("second");
    }
  });

  test("creates missing nested parent directories before writing", () => {
    const filePath = join(tmpRoot, "nested", "deeper", "out.txt");
    expect(() => writeFile(filePath, "hello nested")).not.toThrow();
    expect(readFileSync(filePath, "utf8")).toBe("hello nested");
  });

  test("writes a bare filename with no directory component (cwd-relative)", () => {
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      expect(() => writeFile("out.txt", "hello cwd")).not.toThrow();
      expect(readFileSync(join(tmpRoot, "out.txt"), "utf8")).toBe("hello cwd");
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("retries on EBUSY then succeeds", () => {
    const filePath = join(tmpRoot, "locked.txt");
    let failuresLeft = 2;
    const renameFn: typeof renameSync = (src, dest) => {
      if (failuresLeft > 0) {
        failuresLeft--;
        const err = new Error("resource busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      return renameSync(src, dest);
    };

    writeFile(filePath, "unlocked", undefined, renameFn);

    expect(readFileSync(filePath, "utf8")).toBe("unlocked");
  });
});
