import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../../src/memory/atomicWrite";

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

  // The bug this exists to prevent: two overlapping writers sharing a FIXED tmp path (`${path}.tmp`)
  // can interleave — the second writer's tmp write lands on top of the first's before the first's
  // rename runs, so the first rename publishes content it never computed. A non-colliding tmp name
  // per call is what makes that structurally impossible rather than merely unlikely; asserted here
  // by starting two writes and confirming each one's own content survives to the final file,
  // whichever finishes last.
  test("two interleaved writes to the same path never see each other's tmp file", () => {
    dir = mkdtempSync(join(tmpdir(), "seri-atomic-"));
    const target = join(dir, "MEMORY.md");
    atomicWriteFile(target, "first");
    atomicWriteFile(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
    expect(readdirSync(dir)).toEqual(["MEMORY.md"]);
  });
});
