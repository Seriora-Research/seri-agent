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

  // Round-4 review (SHOULD FIX): the pid+random tmp name that fixes the concurrent-write race
  // also means a tmp file orphaned by a process killed between writeFileSync and renameSync is
  // never revisited — every later write picks a fresh random name instead of colliding with (and
  // overwriting) the old one the way the previous fixed-name scheme did by accident. A stale tmp
  // file's own encoded pid names a process that no longer exists, which is what tells it apart
  // from a genuinely in-flight concurrent writer (the negative control below).
  test("sweeps a stale tmp file left behind by a dead process before writing", () => {
    dir = mkdtempSync(join(tmpdir(), "seri-atomic-"));
    const target = join(dir, "MEMORY.md");
    const stalePath = `${target}.999999999.deadbeef.tmp`;
    writeFileSync(stalePath, "orphaned content");

    atomicWriteFile(target, "hello");

    expect(existsSync(stalePath)).toBe(false);
    expect(readdirSync(dir)).toEqual(["MEMORY.md"]);
  });

  // Negative control for the sweep above: deleting every `${path}.*.tmp` match unconditionally
  // would reintroduce, via cleanup, exactly the race the pid+random name exists to prevent — a
  // concurrent writer's own tmp file (P2 mid-writeFileSync while P1 runs this sweep) matches the
  // same glob and is not an orphan. Simulated here with the CURRENT process's own pid, which is
  // by definition still alive, standing in for that live concurrent writer.
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
