import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendBarrier,
  checkpointStoreDir,
  createCheckpointer,
  pruneSessions,
  readLog,
  rewindConversation,
  undoFiles,
  type CheckpointRecord,
} from "../../src/checkpoint/checkpoint";
import {
  commitTree,
  initShadow,
  isGitAvailable,
  listSessionRefs,
  restoreTree,
  updateRef,
  writeTree,
} from "../../src/checkpoint/shadowGit";
import type { MutationContext } from "../../src/checkpoint/wrapTools";

// The cold first snapshot measured 300 ms on Windows and these tests take several each.
const GIT_TEST_TIMEOUT_MS = 15_000;

let root: string;
let storeDir: string;
let workTree: string;
let warnings: string[];

const SESSION = "session-1";

function mutation(overrides: Partial<MutationContext> = {}): MutationContext {
  return { tool: "write_file", toolCallId: "c1", args: { path: "a.txt" }, rewindTo: 1, ...overrides };
}

function toolRecords(sessionId = SESSION): Extract<CheckpointRecord, { kind: "tool" }>[] {
  return readLog(storeDir, sessionId).filter((record): record is Extract<CheckpointRecord, { kind: "tool" }> => record.kind === "tool");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seri-checkpoint-test-"));
  storeDir = join(root, "store");
  workTree = join(root, "work");
  mkdirSync(workTree, { recursive: true });
  writeFileSync(join(workTree, "a.txt"), "before\n");
  warnings = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function checkpointer(overrides: Partial<Parameters<typeof createCheckpointer>[0]> = {}) {
  return createCheckpointer({
    storeDir,
    worktree: workTree,
    sessionId: SESSION,
    onWarning: (message) => warnings.push(message),
    ...overrides,
  });
}

describe("checkpointStoreDir", () => {
  test.skipIf(process.platform !== "win32")("keys C:\\P and c:\\p to one store on win32", () => {
    expect(checkpointStoreDir("cfg", "C:\\Projects\\App")).toBe(checkpointStoreDir("cfg", "c:\\projects\\app"));
  });

  test("keys different worktrees to different stores", () => {
    expect(checkpointStoreDir("cfg", join(root, "one"))).not.toBe(checkpointStoreDir("cfg", join(root, "two")));
  });
});

describe("createCheckpointer (git absent)", () => {
  test("warns once, creates no store, and never throws", () => {
    const snapshot = checkpointer({ gitAvailable: () => false });

    snapshot(mutation());
    snapshot(mutation({ toolCallId: "c2" }));

    expect(warnings).toEqual([
      "git was not found on PATH — edits in this session are not checkpointed and cannot be undone",
    ]);
    expect(existsSync(storeDir)).toBe(false);
  });
});

describe.skipIf(!isGitAvailable())("createCheckpointer", () => {
  test(
    "records every call but commits only once when nothing changed in between",
    () => {
      const snapshot = checkpointer();

      snapshot(mutation({ toolCallId: "c1" }));
      snapshot(mutation({ toolCallId: "c2" }));

      const records = toolRecords();
      expect(records).toHaveLength(2);
      expect(records[0]?.tree).toBe(records[1]?.tree ?? "");
      expect(records[0]?.commit).toBe(records[1]?.commit ?? "");
      expect(records.map((record) => record.seq)).toEqual([0, 1]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "writes the worktree marker beside the shadow git-dir",
    () => {
      checkpointer()(mutation());

      expect(readFileSync(join(storeDir, "worktree"), "utf8").trim()).toBe(workTree);
      expect(readFileSync(join(storeDir, "git", "info", "attributes"), "utf8")).toBe("* -text\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "warns naming a gitignored path and records it, without blocking the call",
    () => {
      writeFileSync(join(workTree, ".gitignore"), "*.log\n");
      const snapshot = checkpointer();

      snapshot(mutation({ args: { path: "secret.log" } }));

      expect(warnings).toEqual(["secret.log is gitignored, so it is not checkpointed — /undo cannot restore it"]);
      expect(readLog(storeDir, SESSION).filter((record) => record.kind === "ignored")).toEqual([
        expect.objectContaining({ kind: "ignored", path: "secret.log", toolCallId: "c1" }),
      ]);
      expect(toolRecords()).toHaveLength(1);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "says nothing about a path that is not ignored",
    () => {
      writeFileSync(join(workTree, ".gitignore"), "*.log\n");
      checkpointer()(mutation({ args: { path: "a.txt" } }));

      expect(warnings).toEqual([]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "resuming a session keeps appending to the same commit chain",
    () => {
      checkpointer()(mutation({ toolCallId: "c1" }));
      writeFileSync(join(workTree, "a.txt"), "after\n");
      // A second process resuming the same session: a fresh checkpointer over the same store.
      checkpointer()(mutation({ toolCallId: "c2" }));

      const records = toolRecords();
      expect(records).toHaveLength(2);
      expect(records[0]?.commit).not.toBe(records[1]?.commit ?? "");
      expect(records.map((record) => record.seq)).toEqual([0, 1]);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!isGitAvailable())("undoFiles", () => {
  test(
    "restores the previous state, reports what it touched, and leaves a recovery commit",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      writeFileSync(join(workTree, "a.txt"), "after\n");
      writeFileSync(join(workTree, "new.txt"), "new\n");
      snapshot(mutation({ toolCallId: "c2" }));

      const result = undoFiles({ storeDir, worktree: workTree, sessionId: SESSION, steps: 2 });

      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
      expect(existsSync(join(workTree, "new.txt"))).toBe(false);
      expect(result.restored).toEqual(["a.txt"]);
      expect(result.deleted).toEqual(["new.txt"]);
      expect(result.diff).toContain("a.txt");
      expect(result.preUndoCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(readLog(storeDir, SESSION).filter((record) => record.kind === "pre-undo")).toHaveLength(1);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "steps over distinct trees, so a deduped no-op checkpoint is never a step that does nothing",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      snapshot(mutation({ toolCallId: "c2" })); // nothing changed: same tree
      writeFileSync(join(workTree, "a.txt"), "after\n");
      snapshot(mutation({ toolCallId: "c3" }));

      // Three records, two distinct trees — so `/undo 2` must reach the original content rather
      // than land on the duplicate.
      expect(toolRecords()).toHaveLength(3);
      undoFiles({ storeDir, worktree: workTree, sessionId: SESSION, steps: 2 });

      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "never counts the state an earlier undo replaced as a step",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" })); // captures "before"
      writeFileSync(join(workTree, "a.txt"), "v2\n");
      snapshot(mutation({ toolCallId: "c2" })); // captures "v2"
      writeFileSync(join(workTree, "a.txt"), "v3\n");

      // Undoing now writes a pre-undo record whose tree ("v3") appears in no tool record, so if
      // the selection counted pre-undo records the step below would land on it and stop at "v2".
      undoFiles({ storeDir, worktree: workTree, sessionId: SESSION, steps: 1 });
      undoFiles({ storeDir, worktree: workTree, sessionId: SESSION, steps: 2 });

      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "reports the ignored paths it did not restore",
    () => {
      writeFileSync(join(workTree, ".gitignore"), "*.log\n");
      writeFileSync(join(workTree, "secret.log"), "original\n");
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1", args: { path: "secret.log" } }));
      writeFileSync(join(workTree, "secret.log"), "mutated\n");
      writeFileSync(join(workTree, "a.txt"), "after\n");
      snapshot(mutation({ toolCallId: "c2" }));

      const result = undoFiles({ storeDir, worktree: workTree, sessionId: SESSION, steps: 2 });

      expect(result.ignored).toEqual(["secret.log"]);
      expect([...result.restored, ...result.deleted]).not.toContain("secret.log");
      expect(readFileSync(join(workTree, "secret.log"), "utf8")).toBe("mutated\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "refuses to step further back than the session goes",
    () => {
      checkpointer()(mutation());

      expect(() => undoFiles({ storeDir, worktree: workTree, sessionId: SESSION, steps: 5 })).toThrow(
        "This session has 1 checkpoint(s) to undo to; asked for 5.",
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!isGitAvailable())("rewindConversation", () => {
  test(
    "steps over distinct rewind anchors, newest first",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1", rewindTo: 3 }));
      snapshot(mutation({ toolCallId: "c2", rewindTo: 3 })); // same assistant message
      writeFileSync(join(workTree, "a.txt"), "after\n");
      snapshot(mutation({ toolCallId: "c3", rewindTo: 7 }));

      expect(rewindConversation({ storeDir, sessionId: SESSION, steps: 1 })).toEqual({ rewindTo: 7 });
      expect(rewindConversation({ storeDir, sessionId: SESSION, steps: 2 })).toEqual({ rewindTo: 3 });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "refuses to cross a compaction barrier and says compaction is why",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1", rewindTo: 3 }));
      appendBarrier(storeDir, SESSION);
      writeFileSync(join(workTree, "a.txt"), "after\n");
      snapshot(mutation({ toolCallId: "c2", rewindTo: 2 }));

      expect(rewindConversation({ storeDir, sessionId: SESSION, steps: 1 })).toEqual({ rewindTo: 2 });
      expect(() => rewindConversation({ storeDir, sessionId: SESSION, steps: 2 })).toThrow(/summarized away by compaction/);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "leaves the filesystem untouched",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1", rewindTo: 3 }));
      writeFileSync(join(workTree, "a.txt"), "after\n");
      snapshot(mutation({ toolCallId: "c2", rewindTo: 7 }));

      rewindConversation({ storeDir, sessionId: SESSION, steps: 2 });

      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("after\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!isGitAvailable())("pruneSessions", () => {
  test(
    "keeps the newest 20 session refs and leaves their trees restorable",
    () => {
      mkdirSync(storeDir, { recursive: true });
      const gitDir = join(storeDir, "git");
      initShadow(gitDir);

      const trees: string[] = [];
      for (let i = 0; i < 22; i++) {
        writeFileSync(join(workTree, "a.txt"), `session ${i}\n`);
        const tree = writeTree(gitDir, workTree);
        trees.push(tree);
        // Zero-padded so oldest-first holds whether git orders these by commit date or falls back
        // to the ref name — 22 commits made inside one second all carry the same date.
        updateRef(gitDir, `refs/seri/sessions/s${String(i).padStart(2, "0")}`, commitTree(gitDir, workTree, tree));
      }

      pruneSessions(storeDir);

      const refs = listSessionRefs(gitDir);
      expect(refs).toHaveLength(20);
      expect(refs).not.toContain("refs/seri/sessions/s00");
      expect(refs).not.toContain("refs/seri/sessions/s01");
      expect(refs).toContain("refs/seri/sessions/s21");

      // The surviving sessions' snapshots are still reachable after the gc that pruning ran.
      writeFileSync(join(workTree, "a.txt"), "clobbered\n");
      restoreTree(gitDir, workTree, trees[21] ?? "");
      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("session 21\n");
    },
    60_000,
  );
});
