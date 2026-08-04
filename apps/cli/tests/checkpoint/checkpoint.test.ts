import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
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
  applyRestore,
  commitTree,
  initShadow,
  isGitAvailable,
  listSessionRefs,
  planRestore,
  updateRef,
  writeTree,
} from "../../src/checkpoint/shadowGit";
import { withCheckpoints, type MutationContext } from "../../src/checkpoint/wrapTools";
import { toolDefinitions } from "../../src/provider/tools";
import { isBashAvailable } from "../../src/tools/bash";

// The cold first snapshot measured 300 ms on Windows and these tests take several each. Same
// 30 s margin as shadowGit.test.ts, for the same reason.
const GIT_TEST_TIMEOUT_MS = 30_000;

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

// Deliberately not routed through shadowGit: evidence about the store should not come from the
// module that wrote it.
function plainGit(gitDir: string, args: string[]): string {
  const result = spawnSync("git", [`--git-dir=${gitDir}`, ...args], { encoding: "utf8", windowsHide: true });
  return result.stdout;
}

function undo(steps: number) {
  return undoFiles({ storeDir, worktree: workTree, sessionId: SESSION, steps, onPlan: () => {} });
}

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

      const result = undo(2);

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
      undo(2);

      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "ranks a tree that reappears later by its newest occurrence, not its oldest",
    () => {
      // The ordinary flow, not a contrived one: an undo restores an earlier tree, and the next
      // checkpoint records that same tree again — a non-adjacent duplicate the undo itself
      // created. Rank it at its first occurrence and `/undo 1` steps FORWARD onto a state the
      // user just reverted, while printing that it undid.
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" })); // v0
      writeFileSync(join(workTree, "a.txt"), "v1\n");
      snapshot(mutation({ toolCallId: "c2" })); // v1
      writeFileSync(join(workTree, "a.txt"), "v2\n");
      undo(2); // back to v0
      snapshot(mutation({ toolCallId: "c3" })); // v0 again — the duplicate
      writeFileSync(join(workTree, "a.txt"), "v3\n");

      undo(1);

      // "before" is v0 — the seeded content the first checkpoint captured.
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
      undo(1);
      undo(2);

      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "keeps every recovery commit it printed reachable from the session ref",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      writeFileSync(join(workTree, "a.txt"), "v2\n");
      snapshot(mutation({ toolCallId: "c2" }));

      writeFileSync(join(workTree, "a.txt"), "v3\n");
      const first = undo(1);
      writeFileSync(join(workTree, "a.txt"), "v4\n");
      const second = undo(1);

      // Read with plain git: /undo hands each of these hashes to the user as the way back to the
      // state it replaced, and pruneSessions runs `gc` at the start of every session, so a commit
      // that is not an ancestor of the ref is a promise with an expiry date on it.
      const gitDir = join(storeDir, "git");
      const reachable = plainGit(gitDir, ["rev-list", `refs/seri/sessions/${SESSION}`]).split("\n");
      expect(reachable).toContain(first.preUndoCommit);
      expect(reachable).toContain(second.preUndoCommit);
      expect(plainGit(gitDir, ["fsck", "--unreachable"])).not.toContain(first.preUndoCommit);
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

      const result = undo(2);

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

      expect(() => undo(5)).toThrow(
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
    "ranks an anchor that reappears later by its newest occurrence, not its oldest",
    () => {
      // Anchors are monotonic only within one uninterrupted run. A /rewind truncates the array and
      // the messages that follow reuse indices already recorded, so 3, 7, 9, 7, 8 is an ordinary
      // sequence. Ranked by first occurrence it reads [8, 9, 7, 3], and `/rewind 2` then targets
      // 9 — past the end of an 8-message array, where slice is a silent no-op.
      const snapshot = checkpointer();
      for (const [index, rewindTo] of [3, 7, 9, 7, 8].entries()) {
        writeFileSync(join(workTree, "a.txt"), `v${index}\n`);
        snapshot(mutation({ toolCallId: `c${index}`, rewindTo }));
      }

      const at = (steps: number) => rewindConversation({ storeDir, sessionId: SESSION, steps }).rewindTo;
      expect([at(1), at(2), at(3), at(4)]).toEqual([8, 7, 9, 3]);
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

// The discriminating case against a per-edit design: a sed-through-a-temp-file rewrite and an
// appending redirection never call the `edit` tool, so a design that snapshots on edits records
// nothing at all here. The trigger is the tool call and the subject is the whole tree, so seri
// never has to know what the shell did. Bash guard carried forward from tests/tools/bash.test.ts:27.
//
// Deliberately not `sed -i`: GNU sed reads `-i` as "in place, no backup", BSD sed — which is what
// macOS ships — requires an explicit suffix argument and so reads the script as the backup suffix
// and the filename as the script. There is no single `sed -i` spelling that works on both, and
// skipping this on one platform would leave open exactly the hole this test exists to close.
// `> tmp && mv` is portable, and tests the snapshot slightly harder: `mv` replaces the inode
// rather than rewriting the file in place.
describe.skipIf(!isGitAvailable() || !isBashAvailable())("checkpoints around a bash tool call", () => {
  test(
    "captures and undoes a change made only through a shell rewrite and an appending redirection",
    async () => {
      writeFileSync(join(workTree, "b.txt"), "kept\n");
      const tools = withCheckpoints(toolDefinitions, checkpointer());
      const options = { toolCallId: "c1", messages: [{ role: "user" as const, content: "go" }], context: {} };

      await tools.bash?.execute?.(
        {
          command:
            `cd "${workTree.replaceAll("\\", "/")}" && ` +
            `sed 's/before/after/' a.txt > a.tmp && mv a.tmp a.txt && echo appended >> b.txt`,
        },
        options as ToolExecutionOptions<Record<string, unknown>>,
      );

      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("after\n");
      expect(readFileSync(join(workTree, "b.txt"), "utf8")).toBe("kept\nappended\n");

      undo(1);

      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
      expect(readFileSync(join(workTree, "b.txt"), "utf8")).toBe("kept\n");
    },
    30_000,
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
      applyRestore(gitDir, workTree, planRestore(gitDir, workTree, trees[21] ?? "").deleted);
      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("session 21\n");
    },
    60_000,
  );
});
