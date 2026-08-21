import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterSafeToDelete, loadLedger, recordWrite } from "../../src/checkpoint/writeLedger";

let root: string;
let storeDir: string;
let worktree: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seri-write-ledger-test-"));
  storeDir = join(root, "store");
  worktree = join(root, "work");
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadLedger", () => {
  test("returns an empty ledger when no ledger file exists yet", () => {
    expect(loadLedger(storeDir)).toEqual({});
  });

  test("fails safe (empty ledger) on a corrupt ledger file, rather than throwing", () => {
    writeFileSync(join(storeDir, "ledger.json"), "{not valid json");
    expect(loadLedger(storeDir)).toEqual({});
  });

  // Valid JSON that isn't a plain object -- null[path] throws on both read and write, and
  // filterSafeToDelete's call site in restoreTo has no try/catch around it, so an unguarded
  // `null` here would fail /undo outright instead of degrading to "nothing verified".
  test.each(["null", "[]", "42", '"a string"'])(
    "fails safe (empty ledger) on valid but non-object JSON: %s",
    (content) => {
      writeFileSync(join(storeDir, "ledger.json"), content);
      expect(loadLedger(storeDir)).toEqual({});
    },
  );
});

describe("recordWrite", () => {
  test("persists a hash entry that loadLedger reads back", () => {
    const path = join(worktree, "a.txt");
    recordWrite(storeDir, path, "hello\n");

    const ledger = loadLedger(storeDir);
    expect(ledger[path]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a second write to a different path adds an entry instead of replacing the ledger", () => {
    const first = join(worktree, "a.txt");
    const second = join(worktree, "b.txt");
    recordWrite(storeDir, first, "one\n");
    recordWrite(storeDir, second, "two\n");

    const ledger = loadLedger(storeDir);
    expect(Object.keys(ledger).sort()).toEqual([first, second].sort());
  });
});

describe("filterSafeToDelete", () => {
  test("excludes a path with no ledger entry — never written through write_file", () => {
    const path = join(worktree, "unknown.txt");
    writeFileSync(path, "made by the user's editor\n");

    expect(filterSafeToDelete(storeDir, worktree, ["unknown.txt"])).toEqual([]);
  });

  test("includes a path whose on-disk content still matches its ledger entry", () => {
    const path = join(worktree, "a.txt");
    writeFileSync(path, "seri wrote this\n");
    recordWrite(storeDir, path, "seri wrote this\n");

    expect(filterSafeToDelete(storeDir, worktree, ["a.txt"])).toEqual(["a.txt"]);
  });

  test("excludes a path whose on-disk content no longer matches its ledger entry", () => {
    const path = join(worktree, "a.txt");
    writeFileSync(path, "seri wrote this\n");
    recordWrite(storeDir, path, "seri wrote this\n");
    writeFileSync(path, "edited since by something else\n");

    expect(filterSafeToDelete(storeDir, worktree, ["a.txt"])).toEqual([]);
  });

  test("excludes a path with a ledger entry that no longer exists on disk", () => {
    const path = join(worktree, "a.txt");
    writeFileSync(path, "seri wrote this\n");
    recordWrite(storeDir, path, "seri wrote this\n");
    rmSync(path);

    expect(filterSafeToDelete(storeDir, worktree, ["a.txt"])).toEqual([]);
  });

  test("a corrupt ledger excludes every candidate", () => {
    const path = join(worktree, "a.txt");
    writeFileSync(path, "seri wrote this\n");
    recordWrite(storeDir, path, "seri wrote this\n");
    writeFileSync(join(storeDir, "ledger.json"), "{not valid json");

    expect(filterSafeToDelete(storeDir, worktree, ["a.txt"])).toEqual([]);
  });

  test("a ledger file holding literal null excludes every candidate rather than throwing", () => {
    const path = join(worktree, "a.txt");
    writeFileSync(path, "seri wrote this\n");
    recordWrite(storeDir, path, "seri wrote this\n");
    writeFileSync(join(storeDir, "ledger.json"), "null");

    expect(filterSafeToDelete(storeDir, worktree, ["a.txt"])).toEqual([]);
  });

  test("recordWrite does not throw when the existing ledger file holds literal null", () => {
    writeFileSync(join(storeDir, "ledger.json"), "null");
    const path = join(worktree, "a.txt");

    expect(() => recordWrite(storeDir, path, "hello\n")).not.toThrow();
    expect(loadLedger(storeDir)[path]).toMatch(/^[0-9a-f]{64}$/);
  });
});
