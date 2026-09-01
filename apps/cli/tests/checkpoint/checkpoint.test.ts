import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ToolExecutionOptions } from "ai";
import {
  appendBarrier,
  type CheckpointRecord,
  checkpointStoreDir,
  createCheckpointer,
  pruneSessions,
  readLog,
  restoreCommit,
  rewindConversation,
  undoFiles,
} from "../../src/checkpoint/checkpoint";
import {
  applyRestore,
  commitTree,
  initShadow,
  isGitAvailable,
  listSessionRefs,
  planRestore,
  projectRoot,
  updateRef,
  writeTree,
} from "../../src/checkpoint/shadowGit";
import { type MutationContext, withCheckpoints } from "../../src/checkpoint/wrapTools";
import { loadLedger, recordWrite } from "../../src/checkpoint/writeLedger";
import { toolDefinitions } from "../../src/provider/tools";
import { isBashAvailable } from "../../src/tools/bash";
import { getCachedEol, setCachedEol } from "../../src/tools/eolCache";

// The cold first snapshot measured 300 ms on Windows and these tests take several each. Same
// 30 s margin as shadowGit.test.ts, for the same reason.
const GIT_TEST_TIMEOUT_MS = 30_000;

let root: string;
let storeDir: string;
let workTree: string;
let warnings: string[];

const SESSION = "session-1";

// Absolute paths, because a declared relative path is resolved against process.cwd() — which is
// the repo root under `bun test`, not the temp worktree. That is the resolution the tools
// themselves use, so anchoring these to `workTree` by hand is what a real `write_file` call in
// this worktree would have declared.
function mutation(overrides: Partial<MutationContext> = {}): MutationContext {
  return {
    tool: "write_file",
    toolCallId: "c1",
    args: { path: join(workTree, "a.txt") },
    rewindTo: 1,
    ...overrides,
  };
}

function toolRecords(sessionId = SESSION): Extract<CheckpointRecord, { kind: "tool" }>[] {
  return readLog(storeDir, sessionId).filter(
    (record): record is Extract<CheckpointRecord, { kind: "tool" }> => record.kind === "tool",
  );
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
  const result = spawnSync("git", [`--git-dir=${gitDir}`, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
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
    expect(checkpointStoreDir("cfg", "C:\\Projects\\App")).toBe(
      checkpointStoreDir("cfg", "c:\\projects\\app"),
    );
  });

  // Neither development box can run this one: Windows skips it and WSL skips it, so CI's macOS leg
  // is the only thing anywhere that will ever execute it. That is the reason it has to exist —
  // APFS is case-insensitive by default exactly as NTFS is, and without this nothing checks that
  // the folding still covers darwin.
  test.skipIf(process.platform !== "darwin")("keys /Proj and /proj to one store on darwin", () => {
    expect(checkpointStoreDir("cfg", "/Users/x/Projects/App")).toBe(
      checkpointStoreDir("cfg", "/users/x/projects/app"),
    );
  });

  test("keys different worktrees to different stores", () => {
    expect(checkpointStoreDir("cfg", join(root, "one"))).not.toBe(
      checkpointStoreDir("cfg", join(root, "two")),
    );
  });
});

describe("createCheckpointer (git absent)", () => {
  test("records a relative write_file path against the session cwd, not process.cwd()", () => {
    const cwd = join(root, "session-cwd");
    mkdirSync(cwd);
    mkdirSync(storeDir);
    writeFileSync(join(cwd, "note.txt"), "daemon wrote this\n");
    const snapshot = checkpointer({ cwd, gitAvailable: () => false });
    snapshot.onAfterMutation({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: "note.txt" },
      rewindTo: 1,
    });
    expect(loadLedger(storeDir)[join(cwd, "note.txt")]).toMatch(/^[0-9a-f]{64}$/);
    expect(loadLedger(storeDir)[resolve("note.txt")]).toBeUndefined();
  });

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

      const secret = join(workTree, "secret.log");
      snapshot(mutation({ args: { path: secret } }));

      expect(warnings).toEqual([
        `${secret} is gitignored, so it is not checkpointed — /undo cannot restore it`,
      ]);
      expect(readLog(storeDir, SESSION).filter((record) => record.kind === "ignored")).toEqual([
        expect.objectContaining({ kind: "ignored", path: secret, toolCallId: "c1" }),
      ]);
      expect(toolRecords()).toHaveLength(1);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "keeps checkpointing the worktree after a write to a path outside it",
    () => {
      // Writing a scratch file to a temp dir or ~/.config is ordinary model behaviour. `git
      // check-ignore` exits 128 for such a path ("is outside repository"), which used to throw
      // into the error latch and turn checkpointing off for the whole session — measured: zero
      // records in the log and one warning, with every later edit unprotected.
      const outside = join(root, "notes.md");
      const snapshot = checkpointer();

      snapshot(mutation({ toolCallId: "c1", args: { path: outside } }));
      writeFileSync(join(workTree, "a.txt"), "v2\n");
      snapshot(mutation({ toolCallId: "c2" }));
      writeFileSync(join(workTree, "a.txt"), "v3\n");
      snapshot(mutation({ toolCallId: "c3" }));

      expect(toolRecords()).toHaveLength(3);
      expect(warnings).toEqual([
        `${outside} is outside ${workTree}, so it is not checkpointed — /undo cannot restore it`,
      ]);

      undo(2);

      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("v2\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "checkpoints the project root, so a repo-root .gitignore applies to a session started below it",
    () => {
      // gitignore(5) reads .gitignore files only up to the top level of the work tree, so with the
      // work-tree pointed at the subdirectory the root's rules were never consulted. Measured:
      // `--work-tree=repo/pkg add -A` staged `.env` and `node_modules/x.js` against a repo-root
      // .gitignore naming both, i.e. `cd repo/pkg && seri "…"` copied the project's secrets into
      // <configDir>, outside the repo where git clean never reaches them.
      const repo = join(root, "repo");
      const sub = join(repo, "pkg");
      mkdirSync(join(sub, "node_modules"), { recursive: true });
      spawnSync("git", ["init", "-q"], { cwd: repo, windowsHide: true });
      writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
      writeFileSync(join(sub, ".env"), "SECRET=1\n");
      writeFileSync(join(sub, "node_modules", "x.js"), "x\n");
      writeFileSync(join(sub, "a.txt"), "a\n");

      const worktree = projectRoot(sub);
      // Compared by name, not by string: on macOS the toplevel comes back through /private and
      // would not equal the path the test built.
      expect(basename(worktree)).toBe("repo");

      createCheckpointer({
        storeDir,
        worktree,
        sessionId: SESSION,
        onWarning: (m) => warnings.push(m),
      })({
        tool: "write_file",
        toolCallId: "c1",
        args: { path: join(sub, "a.txt") },
        rewindTo: 1,
      });

      const staged = plainGit(join(storeDir, "git"), [
        "ls-tree",
        "-r",
        "--name-only",
        toolRecords()[0]?.tree ?? "",
      ]);
      expect(staged).toContain("pkg/a.txt");
      expect(staged).not.toContain(".env");
      expect(staged).not.toContain("node_modules");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "honours the user's .git/info/exclude, so a locally-excluded file is neither copied nor deleted",
    () => {
      // `--exclude-standard` reads $GIT_DIR/info/exclude, and $GIT_DIR is the shadow store, so the
      // user's local excludes were invisible in both directions: the file was copied into
      // <configDir> (outside the repo, where git clean never reaches it) and a locally-excluded
      // file made after a snapshot was deleted by the removal pass without appearing in the plan.
      spawnSync("git", ["init", "-q"], { cwd: workTree, windowsHide: true });
      mkdirSync(join(workTree, ".git", "info"), { recursive: true });
      writeFileSync(join(workTree, ".git", "info", "exclude"), "local-secret.txt\n*.local\n");
      writeFileSync(join(workTree, "local-secret.txt"), "SECRET\n");

      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      writeFileSync(join(workTree, "a.txt"), "v2\n");
      writeFileSync(join(workTree, "made-later.local"), "notes\n");
      snapshot(mutation({ toolCallId: "c2" }));

      // Half one: never copied into the store.
      const tree = toolRecords()[0]?.tree ?? "";
      expect(plainGit(join(storeDir, "git"), ["ls-tree", "-r", "--name-only", tree])).not.toContain(
        "local-secret.txt",
      );

      // Half two: never deleted by the removal pass.
      const result = undo(2);

      expect(result.deleted).not.toContain("made-later.local");
      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
      expect(readFileSync(join(workTree, "local-secret.txt"), "utf8")).toBe("SECRET\n");
      expect(readFileSync(join(workTree, "made-later.local"), "utf8")).toBe("notes\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "resolves a declared relative path the way the tool that declared it will",
    () => {
      // process.cwd() under `bun test` is the repo root, not this temp worktree — the same
      // divergence as `seri --resume <id>` run from a subdirectory. write_file passes the declared
      // path straight to node:fs, so it would create <cwd>/a.txt; resolving it against the worktree
      // instead answered about a different file, and with a root-anchored rule in .gitignore that
      // produced a warning about a file that had in fact been checkpointed.
      checkpointer()(mutation({ args: { path: "a.txt" } }));

      expect(warnings).toEqual([
        `a.txt is outside ${workTree}, so it is not checkpointed — /undo cannot restore it`,
      ]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "warns that a nested git repository is not covered, rather than reporting an undo that missed it",
    () => {
      // `add -A` records a nested repo as a gitlink holding only its HEAD sha. Measured: editing
      // nested/a.txt and creating nested/b.txt left write-tree returning the identical sha, so
      // /undo restores the outer files, prints "restored …" and leaves every change under a
      // submodule or vendored clone in place — green and empty, in a narrower form.
      const nested = join(workTree, "nested");
      mkdirSync(nested, { recursive: true });
      spawnSync("git", ["init", "-q"], { cwd: nested, windowsHide: true });
      writeFileSync(join(nested, "a.txt"), "v1\n");
      spawnSync("git", ["add", "-A"], { cwd: nested, windowsHide: true });
      spawnSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-qm",
          "x",
        ],
        {
          cwd: nested,
          windowsHide: true,
        },
      );

      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      // Second call: the warning is once per session, not once per tool call.
      writeFileSync(join(nested, "a.txt"), "v2\n");
      snapshot(mutation({ toolCallId: "c2" }));

      expect(warnings).toEqual([
        "nested is a nested git repository — changes inside are not checkpointed and /undo will not revert them",
      ]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "says nothing about a path that is not ignored",
    () => {
      writeFileSync(join(workTree, ".gitignore"), "*.log\n");
      checkpointer()(mutation({ args: { path: join(workTree, "a.txt") } }));

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

  test(
    "a resumed session's first call snapshots for real even when it is a non-destructive bash command",
    () => {
      // --resume seeds `previousTree` from the log's last checkpoint before this process has taken
      // any snapshot of its own. Without a per-process flag a harmless `ls` right after resuming
      // reused that stale tree and missed the change made below, which is exactly the gap `/undo`
      // could fall into if the filesystem changed between the previous process exiting and this one
      // resuming.
      checkpointer()(mutation({ toolCallId: "c1" }));
      writeFileSync(join(workTree, "a.txt"), "after\n");
      const snapshot = checkpointer();
      snapshot({ tool: "bash", toolCallId: "c2", args: { command: "ls" }, rewindTo: 2 });

      const records = toolRecords();
      expect(records).toHaveLength(2);
      expect(records[1]?.tree).not.toBe(records[0]?.tree);
      expect(plainGit(join(storeDir, "git"), ["show", `${records[1]?.tree}:a.txt`])).toBe(
        "after\n",
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!isGitAvailable())("createCheckpointer (destructive-command gate)", () => {
  test(
    "snapshots for real on the very first call of a session, even a harmless bash command",
    () => {
      const snapshot = checkpointer();
      snapshot({ tool: "bash", toolCallId: "c1", args: { command: "ls" }, rewindTo: 1 });

      const records = toolRecords();
      expect(records).toHaveLength(1);
      expect(
        plainGit(join(storeDir, "git"), ["ls-tree", "-r", "--name-only", records[0]?.tree ?? ""]),
      ).toContain("a.txt");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "a non-destructive bash call reuses the previous tree instead of restaging the worktree",
    () => {
      const snapshot = checkpointer();
      snapshot({ tool: "bash", toolCallId: "c1", args: { command: "ls" }, rewindTo: 1 });
      writeFileSync(join(workTree, "new.txt"), "new\n");
      snapshot({ tool: "bash", toolCallId: "c2", args: { command: "git status" }, rewindTo: 2 });

      const records = toolRecords();
      expect(records).toHaveLength(2);
      expect(records[1]?.tree).toBe(records[0]?.tree);
      expect(records[1]?.commit).toBe(records[0]?.commit);
      expect(
        plainGit(join(storeDir, "git"), ["ls-tree", "-r", "--name-only", records[1]?.tree ?? ""]),
      ).not.toContain("new.txt");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "a destructive bash call restages the worktree",
    () => {
      const snapshot = checkpointer();
      snapshot({ tool: "bash", toolCallId: "c1", args: { command: "ls" }, rewindTo: 1 });
      writeFileSync(join(workTree, "new.txt"), "new\n");
      snapshot({ tool: "bash", toolCallId: "c2", args: { command: "rm -rf build" }, rewindTo: 2 });

      const records = toolRecords();
      expect(records[1]?.tree).not.toBe(records[0]?.tree);
      expect(
        plainGit(join(storeDir, "git"), ["ls-tree", "-r", "--name-only", records[1]?.tree ?? ""]),
      ).toContain("new.txt");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test.each([
    "git restore file.txt",
    "git stash",
    "git apply patch.diff",
    "tee out.txt",
    "patch -p1 < patch.diff",
    // \b does not fire between "n" and "i" (both word characters) — /\binstall\b/ alone never
    // matched "uninstall" (verified: false against this exact string before the fix). "git rm"/
    // "git mv" are NOT added here even though a review flagged them as missing: the plain
    // /\brm\b/ and /\bmv\b/ patterns already match "git rm ..."/"git mv ..." as a substring word,
    // verified directly — a dedicated git-rm/git-mv pattern would have been dead weight.
    "npm uninstall lodash",
    // A standard POSIX single-file delete, distinct from `rm` — not a substring of any covered
    // word, so it needs its own pattern rather than being caught incidentally.
    "unlink file.txt",
  ])(
    "a destructive bash call restages the worktree: %s",
    (command) => {
      const snapshot = checkpointer();
      snapshot({ tool: "bash", toolCallId: "c1", args: { command: "ls" }, rewindTo: 1 });
      writeFileSync(join(workTree, "new.txt"), "new\n");
      snapshot({ tool: "bash", toolCallId: "c2", args: { command }, rewindTo: 2 });

      const records = toolRecords();
      expect(records[1]?.tree).not.toBe(records[0]?.tree);
      expect(
        plainGit(join(storeDir, "git"), ["ls-tree", "-r", "--name-only", records[1]?.tree ?? ""]),
      ).toContain("new.txt");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  // Regression guard for the missing `s` (dotAll) flag: without it, `.` in `/\bsed\b.*-i\b/` cannot
  // cross a newline, so a command split by a backslash line-continuation — a real, plausible shape
  // for a multi-line bash command, not a contrived one — never matched and silently skipped the
  // snapshot a genuine `sed -i` should have forced.
  test(
    "a destructive bash call restages the worktree even when split across lines by a backslash continuation",
    () => {
      const snapshot = checkpointer();
      snapshot({ tool: "bash", toolCallId: "c1", args: { command: "ls" }, rewindTo: 1 });
      writeFileSync(join(workTree, "new.txt"), "new\n");
      snapshot({
        tool: "bash",
        toolCallId: "c2",
        args: { command: "sed \\\n  -i 's/a/b/' file.txt" },
        rewindTo: 2,
      });

      const records = toolRecords();
      expect(records[1]?.tree).not.toBe(records[0]?.tree);
      expect(
        plainGit(join(storeDir, "git"), ["ls-tree", "-r", "--name-only", records[1]?.tree ?? ""]),
      ).toContain("new.txt");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  // Same dotAll gap on the PowerShell side: /\bCopy-Item\b.*-Force\b/i needed the same fix.
  test(
    "a destructive PowerShell call restages the worktree even when split across lines by a backtick continuation",
    () => {
      const snapshot = checkpointer();
      snapshot({
        tool: "powershell",
        toolCallId: "c1",
        args: { command: "Get-ChildItem" },
        rewindTo: 1,
      });
      writeFileSync(join(workTree, "new.txt"), "new\n");
      snapshot({
        tool: "powershell",
        toolCallId: "c2",
        args: { command: "Copy-Item a.txt b.txt `\n  -Force" },
        rewindTo: 2,
      });

      const records = toolRecords();
      expect(records[1]?.tree).not.toBe(records[0]?.tree);
      expect(
        plainGit(join(storeDir, "git"), ["ls-tree", "-r", "--name-only", records[1]?.tree ?? ""]),
      ).toContain("new.txt");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "write_file after a shell snapshot still restages the whole worktree",
    () => {
      const snapshot = checkpointer();
      snapshot({ tool: "bash", toolCallId: "c1", args: { command: "ls" }, rewindTo: 1 });
      writeFileSync(join(workTree, "new.txt"), "new\n");
      snapshot(mutation({ toolCallId: "c2" }));

      const records = toolRecords();
      expect(records[1]?.tree).not.toBe(records[0]?.tree);
      expect(
        plainGit(join(storeDir, "git"), ["ls-tree", "-r", "--name-only", records[1]?.tree ?? ""]),
      ).toContain("new.txt");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "later write_file restages a previous write without walking the rest of the worktree",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      writeFileSync(join(workTree, "a.txt"), "first\n");
      writeFileSync(join(workTree, "sneaky.txt"), "unrelated\n");
      snapshot(
        mutation({
          toolCallId: "c2",
          args: { path: join(workTree, "b.txt") },
        }),
      );

      const records = toolRecords();
      expect(plainGit(join(storeDir, "git"), ["show", `${records[1]?.tree}:a.txt`])).toBe(
        "first\n",
      );
      expect(
        plainGit(join(storeDir, "git"), ["ls-tree", "-r", "--name-only", records[1]?.tree ?? ""]),
      ).not.toContain("sneaky.txt");
      expect(
        plainGit(join(storeDir, "git"), ["ls-tree", "-r", "--name-only", records[1]?.tree ?? ""]),
      ).not.toContain("b.txt");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "later write_file of a gitignored path does not latch checkpointing off",
    () => {
      writeFileSync(join(workTree, ".gitignore"), "*.log\n");
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      snapshot(
        mutation({
          toolCallId: "c2",
          args: { path: join(workTree, "secret.log") },
        }),
      );
      writeFileSync(join(workTree, "a.txt"), "after\n");
      snapshot(mutation({ toolCallId: "c3" }));

      expect(toolRecords().map((record) => record.toolCallId)).toEqual(["c1", "c2", "c3"]);
      expect(warnings.some((message) => message.startsWith("checkpointing is off"))).toBe(false);
      expect(plainGit(join(storeDir, "git"), ["show", `${toolRecords()[2]?.tree}:a.txt`])).toBe(
        "after\n",
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "still appends one record per call when writeTree is skipped, so /undo's per-call granularity is unaffected",
    () => {
      const snapshot = checkpointer();
      snapshot({ tool: "bash", toolCallId: "c1", args: { command: "ls" }, rewindTo: 1 });
      snapshot({ tool: "bash", toolCallId: "c2", args: { command: "git status" }, rewindTo: 2 });
      snapshot({ tool: "bash", toolCallId: "c3", args: { command: "pwd" }, rewindTo: 3 });

      expect(toolRecords().map((record) => record.toolCallId)).toEqual(["c1", "c2", "c3"]);
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
      // Stands in for write_file's own onAfterMutation (checkpoint.ts's real createCheckpointer
      // calls this after every successful write_file) — the ledger is what proves seri, not the
      // user, made this file, which is what the removal pass below now requires before deleting it.
      recordWrite(storeDir, join(workTree, "new.txt"), "new\n");
      snapshot(mutation({ toolCallId: "c2" }));

      const result = undo(2);

      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
      expect(existsSync(join(workTree, "new.txt"))).toBe(false);
      expect(result.restored).toEqual(["a.txt"]);
      expect(result.deleted).toEqual(["new.txt"]);
      expect(result.diff).toContain("a.txt");
      expect(result.preUndoCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(
        readLog(storeDir, SESSION).filter((record) => record.kind === "pre-undo"),
      ).toHaveLength(1);
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
      snapshot(mutation({ toolCallId: "c1", args: { path: join(workTree, "secret.log") } }));
      writeFileSync(join(workTree, "secret.log"), "mutated\n");
      writeFileSync(join(workTree, "a.txt"), "after\n");
      snapshot(mutation({ toolCallId: "c2" }));

      const result = undo(2);

      expect(result.ignored).toEqual([join(workTree, "secret.log")]);
      expect([...result.restored, ...result.deleted]).not.toContain("secret.log");
      expect(readFileSync(join(workTree, "secret.log"), "utf8")).toBe("mutated\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "reports only the ignored writes at or after the checkpoint it restores to",
    () => {
      // Session-wide, `/undo 1` announced a gitignored file written twenty tool calls earlier in
      // the same breath as the paths it had just restored — an undo that was never going to touch
      // it either way.
      writeFileSync(join(workTree, ".gitignore"), "*.log\n");
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1", args: { path: join(workTree, "secret.log") } }));
      writeFileSync(join(workTree, "a.txt"), "v2\n");
      snapshot(mutation({ toolCallId: "c2" }));
      writeFileSync(join(workTree, "a.txt"), "v3\n");
      snapshot(mutation({ toolCallId: "c3" }));

      expect(undo(1).ignored).toEqual([]);
      // Stepping back to the checkpoint the ignored write happened at does report it: the record is
      // appended just before that call's own tool record.
      expect(undo(3).ignored).toEqual([join(workTree, "secret.log")]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "drops a truncated final log line instead of latching checkpointing off for the session",
    () => {
      // The log is appended to with no fsync, so a kill or an ENOSPC mid-appendFileSync leaves half
      // a line. A JSON.parse throw for it used to latch checkpointing off with a raw SyntaxError
      // as the warning, and leave /undo, /rewind and /restore unusable for that session forever.
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      writeFileSync(join(workTree, "a.txt"), "v2\n");
      snapshot(mutation({ toolCallId: "c2" }));
      // The process died here, mid-append, leaving half a record as the last line.
      appendFileSync(join(storeDir, `${SESSION}.jsonl`), '{"kind":"tool","seq":2,"tre');

      expect(toolRecords()).toHaveLength(2);
      undo(2);
      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "rejects a commit that is not in the store without touching the ref or the log",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      const before = readLog(storeDir, SESSION).length;

      expect(() =>
        restoreCommit({
          storeDir,
          worktree: workTree,
          sessionId: SESSION,
          commit: "deadbeef",
          onPlan: () => {},
        }),
      ).toThrow("deadbeef is not a checkpoint in this session's store.");

      // The point of validating first: a typo used to leave a minted commit, a moved ref and a
      // pre-undo record behind, and every retry appended another.
      expect(readLog(storeDir, SESSION)).toHaveLength(before);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "refuses to step further back than the session goes",
    () => {
      checkpointer()(mutation());

      expect(() => undo(5)).toThrow("This session has 1 checkpoint(s) to undo to; asked for 5.");
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!isGitAvailable())("undoFiles (write-ledger deletion gate)", () => {
  test(
    "an out-of-band file created after a skipped bash call survives — the file this fix exists for",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" })); // captures "before" — where /undo will land

      // The gap Repro-B exploited: a non-destructive bash call between the checkpoint and the
      // out-of-band edit reuses the previous tree (DESTRUCTIVE_COMMAND_PATTERNS' own comment), so
      // nothing looks at disk again until the next real snapshot — which never comes, because /undo
      // fires next instead.
      snapshot({ tool: "bash", toolCallId: "c2", args: { command: "ls" }, rewindTo: 2 });

      // Made directly with node:fs, the way a user's own editor would — never through write_file,
      // so it can never have a ledger entry.
      writeFileSync(join(workTree, "user-made.txt"), "the user's own work\n");

      // Negative control: planRestore's raw output — what the removal pass saw before this fix's
      // ledger gate narrowed it — does list the file as extraneous against the target tree. If this
      // assertion ever stops holding, the assertions below are no longer proving anything.
      const gitDir = join(storeDir, "git");
      const target = toolRecords()[0]?.tree ?? "";
      expect(planRestore(gitDir, workTree, target).deleted).toContain("user-made.txt");

      const result = undo(1);

      expect(result.deleted).not.toContain("user-made.txt");
      expect(result.preserved).toContain("user-made.txt");
      expect(existsSync(join(workTree, "user-made.txt"))).toBe(true);
      expect(readFileSync(join(workTree, "user-made.txt"), "utf8")).toBe("the user's own work\n");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "a file seri actually wrote through write_file, and that legitimately should not exist after the restore, is still deleted",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" })); // captures "before" — where /undo will land

      writeFileSync(join(workTree, "seri-made.txt"), "seri wrote this\n");
      recordWrite(storeDir, join(workTree, "seri-made.txt"), "seri wrote this\n");
      snapshot(mutation({ toolCallId: "c2" }));

      // c2 snapshotted write_file of a.txt, so the new file is not in that tree — the two
      // records share one filesystem checkpoint, and one undo step lands on "before".
      const result = undo(1);

      expect(result.deleted).toContain("seri-made.txt");
      expect(result.preserved).not.toContain("seri-made.txt");
      expect(existsSync(join(workTree, "seri-made.txt"))).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "a file seri wrote, then something else modified afterward, is preserved rather than deleted",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" })); // captures "before" — where /undo will land

      writeFileSync(join(workTree, "written-then-edited.txt"), "seri's content\n");
      recordWrite(storeDir, join(workTree, "written-then-edited.txt"), "seri's content\n");
      snapshot(mutation({ toolCallId: "c2" }));

      // Edited by something else after seri wrote it — the ledger's hash no longer matches what is
      // on disk.
      writeFileSync(join(workTree, "written-then-edited.txt"), "edited by someone else\n");

      const result = undo(1);

      expect(result.deleted).not.toContain("written-then-edited.txt");
      expect(result.preserved).toContain("written-then-edited.txt");
      expect(readFileSync(join(workTree, "written-then-edited.txt"), "utf8")).toBe(
        "edited by someone else\n",
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  // TOCTOU regression guard: onPlan is the one caller-supplied hook restoreTo calls between the
  // ledger check that decides what gets printed as `plan.deleted` and the actual deletion — the
  // real window a concurrent editor would race through in production. Editing the file from inside
  // onPlan simulates exactly that race deterministically, without timing.
  test(
    "a file that passed the ledger check but was modified before the actual delete is preserved, not deleted",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" })); // captures "before" — where /undo will land

      writeFileSync(join(workTree, "raced.txt"), "seri's content\n");
      recordWrite(storeDir, join(workTree, "raced.txt"), "seri's content\n");
      snapshot(mutation({ toolCallId: "c2" }));

      const result = undoFiles({
        storeDir,
        worktree: workTree,
        sessionId: SESSION,
        steps: 1,
        onPlan: (plan) => {
          // The first check passed — raced.txt hashes to what recordWrite vouched for.
          expect(plan.deleted).toContain("raced.txt");
          writeFileSync(join(workTree, "raced.txt"), "edited after the plan was printed\n");
        },
      });

      expect(result.deleted).not.toContain("raced.txt");
      expect(result.preserved).toContain("raced.txt");
      expect(readFileSync(join(workTree, "raced.txt"), "utf8")).toBe(
        "edited after the plan was printed\n",
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!isGitAvailable())("createCheckpointer's invalidate()", () => {
  test(
    "re-derives previousCommit from the session ref, so a checkpoint taken after a restore chains onto it",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      writeFileSync(join(workTree, "a.txt"), "v2\n");
      snapshot(mutation({ toolCallId: "c2" }));

      // undoFiles moves the session ref on its own, exactly as restoreTo does in production — this
      // closure's own previousCommit has no way to know that happened without invalidate().
      const result = undo(1);

      snapshot.invalidate();
      writeFileSync(join(workTree, "a.txt"), "v3\n");
      snapshot(mutation({ toolCallId: "c3" }));

      // The new checkpoint must chain onto the pre-undo commit restoreTo minted — proving
      // invalidate() re-read the ref rather than parenting the next commit on the stale,
      // pre-restore commit this closure had cached before the undo ran.
      const gitDir = join(storeDir, "git");
      const commit = toolRecords().at(-1)?.commit ?? "";
      expect(plainGit(gitDir, ["rev-list", commit]).split("\n").filter(Boolean)).toContain(
        result.preUndoCommit,
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  // restoreTo (checkpoint.ts) moves the session ref and appends the "pre-undo" record BEFORE it
  // calls applyRestore, so a throw from applyRestore itself (an EPERM/EBUSY on Windows from a file
  // held open by a watcher or dev server, per applyRestore's own comment in shadowGit.ts — or any
  // other mid-restore failure) still leaves the ref moved. That is the exact case cli.ts's own
  // onSubmit now calls invalidate() in a `finally` for, so it runs whether or not the restore
  // itself threw. A real permission/lock throw turned out not to be reproducible deterministically
  // on every machine this repo runs on — a read-only attribute and an open write handle both let
  // rmSync delete the file anyway on at least one tested Windows/Bun combination. `checkout-index`
  // reading a blob that was deleted out from under it fails identically on every platform, so that
  // is what forces applyRestore to throw here instead.
  test(
    "invalidate() still lets the next checkpoint chain onto the pre-undo commit when the restore itself threw",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      const c1Tree = toolRecords().at(-1)?.tree ?? "";

      writeFileSync(join(workTree, "a.txt"), "v2\n");
      snapshot(mutation({ toolCallId: "c2" }));

      // checkout-index needs a.txt's blob from c1's tree to restore it — deleting the loose object
      // makes that read fail the same way on every platform, unlike a permission-based throw.
      const gitDir = join(storeDir, "git");
      const blob = plainGit(gitDir, ["ls-tree", c1Tree, "--", "a.txt"]).split(/\s+/)[2] ?? "";
      rmSync(join(gitDir, "objects", blob.slice(0, 2), blob.slice(2)), { force: true });

      let threw: unknown;
      try {
        // Two distinct trees on the log (c1, c2), so /undo 2 is what reaches c1's state — /undo 1
        // targets the newest anchor, c2's own tree, same as every other two-checkpoint test in this
        // file. Restoring to c1 must check out a.txt's now-missing blob.
        undo(2);
      } catch (err) {
        threw = err;
      } finally {
        // Mirrors cli.ts's onSubmit: invalidate() runs unconditionally, not only on success.
        snapshot.invalidate();
      }
      expect(threw).toBeDefined();

      writeFileSync(join(workTree, "a.txt"), "after-throw\n");
      snapshot(mutation({ toolCallId: "c3" }));

      // The pre-undo commit was minted (and the ref moved) before applyRestore threw — readLog,
      // not undo()'s return value, since the throw meant undo(2) above never returned one.
      const preUndoCommit = readLog(storeDir, SESSION)
        .filter((record): record is Extract<CheckpointRecord, { kind: "pre-undo" }> => {
          return record.kind === "pre-undo";
        })
        .at(-1)?.commit;
      expect(preUndoCommit).toBeDefined();
      const commit = toolRecords().at(-1)?.commit ?? "";
      expect(plainGit(gitDir, ["rev-list", commit]).split("\n").filter(Boolean)).toContain(
        preUndoCommit as string,
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  // Same throw trigger as the test above, but proving a different consequence of the same
  // try/finally-less bug: checkout-index rewrites a restored file's on-disk EOL before applyRestore
  // gets to the deletion loop that (via the deleted blob) throws, so a stale cache entry left behind
  // by the throw would mislead the next write into skipping the CRLF conversion the restore just
  // performed.
  test(
    "clears the EOL cache even when the restore itself threw",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));
      const c1Tree = toolRecords().at(-1)?.tree ?? "";

      writeFileSync(join(workTree, "a.txt"), "v2\n");
      snapshot(mutation({ toolCallId: "c2" }));

      const gitDir = join(storeDir, "git");
      const blob = plainGit(gitDir, ["ls-tree", c1Tree, "--", "a.txt"]).split(/\s+/)[2] ?? "";
      rmSync(join(gitDir, "objects", blob.slice(0, 2), blob.slice(2)), { force: true });

      setCachedEol(join(workTree, "a.txt"), "CRLF");

      let threw: unknown;
      try {
        undo(2);
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeDefined();

      expect(getCachedEol(join(workTree, "a.txt"))).toBeUndefined();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  // resolveRef itself throwing (git failing to even spawn, per shadowGit.ts's spawnGit) is a
  // narrower trigger than a non-zero exit — PATH pointed at a directory with no `git` in it so
  // `spawnSync("git", ...)` cannot find the binary at all, the one case shadowGit.ts's own run()
  // throws rather than returning a failed GitResult. Proves snapshottedThisProcess is reset before
  // that throw, not after: a stale `true` there would make the next non-destructive, non-write_file
  // call skip writeTree and reuse previousTree — already cleared to undefined by this point —
  // corrupting that checkpoint's tree. NOT an emptied `PATH` (`PATH = ""`): confirmed live on Bun
  // 1.4.0/Linux and macOS, `spawnSync` still resolves and runs `git` successfully with an emptied
  // `PATH` in the child's own `env` — a real Bun/POSIX executable-resolution quirk, not something
  // this test can rely on. A `PATH` pointed at a real, git-less directory fails to resolve on every
  // platform.
  test(
    "invalidate() still forces a fresh snapshot on the next call when resolveRef itself throws",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1" }));

      const originalPath = process.env.PATH;
      const noGitPath = mkdtempSync(join(tmpdir(), "seri-no-git-"));
      process.env.PATH = noGitPath;
      let threw: unknown;
      try {
        snapshot.invalidate();
      } catch (err) {
        threw = err;
      } finally {
        process.env.PATH = originalPath;
        rmSync(noGitPath, { recursive: true, force: true });
      }
      expect(threw).toBeDefined();

      writeFileSync(join(workTree, "a.txt"), "after-throw\n");
      // A plain "ls" is exactly the case that would have reused the stale, now-undefined
      // previousTree if snapshottedThisProcess had not been reset before the throw.
      snapshot({ tool: "bash", toolCallId: "c2", args: { command: "ls" }, rewindTo: 2 });

      expect(toolRecords()[1]?.tree).toMatch(/^[0-9a-f]{40}$/);
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

      expect(rewindConversation({ storeDir, sessionId: SESSION, steps: 1 })).toEqual({
        rewindTo: 7,
      });
      expect(rewindConversation({ storeDir, sessionId: SESSION, steps: 2 })).toEqual({
        rewindTo: 3,
      });
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

      const at = (steps: number) =>
        rewindConversation({ storeDir, sessionId: SESSION, steps }).rewindTo;
      expect([at(1), at(2), at(3), at(4)]).toEqual([8, 7, 9, 3]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "refuses to cross a compaction barrier and says compaction is why",
    () => {
      const snapshot = checkpointer();
      snapshot(mutation({ toolCallId: "c1", rewindTo: 3 }));
      appendBarrier(storeDir, SESSION, "compaction");
      writeFileSync(join(workTree, "a.txt"), "after\n");
      snapshot(mutation({ toolCallId: "c2", rewindTo: 2 }));

      expect(rewindConversation({ storeDir, sessionId: SESSION, steps: 1 })).toEqual({
        rewindTo: 2,
      });
      expect(() => rewindConversation({ storeDir, sessionId: SESSION, steps: 2 })).toThrow(
        /summarized away by compaction/,
      );
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
describe.skipIf(!isGitAvailable() || !isBashAvailable())(
  "checkpoints around a bash tool call",
  () => {
    test("captures and undoes a change made only through a shell rewrite and an appending redirection", async () => {
      writeFileSync(join(workTree, "b.txt"), "kept\n");
      const tools = withCheckpoints(toolDefinitions, checkpointer());
      const options = {
        toolCallId: "c1",
        messages: [{ role: "user" as const, content: "go" }],
        context: {},
      };

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
    }, 30_000);
  },
);

describe.skipIf(!isGitAvailable())("pruneSessions", () => {
  test("keeps the newest 20 session refs and leaves their trees restorable", () => {
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
      updateRef(
        gitDir,
        `refs/seri/sessions/s${String(i).padStart(2, "0")}`,
        commitTree(gitDir, workTree, tree),
      );
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
  }, 60_000);

  test("deletes a pruned session's log with its ref, so no log outlives its snapshots", () => {
    mkdirSync(storeDir, { recursive: true });
    const gitDir = join(storeDir, "git");
    initShadow(gitDir);

    for (let i = 0; i < 21; i++) {
      writeFileSync(join(workTree, "a.txt"), `session ${i}\n`);
      const ref = `refs/seri/sessions/s${String(i).padStart(2, "0")}`;
      updateRef(gitDir, ref, commitTree(gitDir, workTree, writeTree(gitDir, workTree)));
      writeFileSync(join(storeDir, `s${String(i).padStart(2, "0")}.jsonl`), "");
    }

    pruneSessions(storeDir);

    // Left behind, /undo on the pruned session read a full history, computed targets from it and
    // then failed at treeExists — contradicting the file it had just read.
    expect(existsSync(join(storeDir, "s00.jsonl"))).toBe(false);
    expect(existsSync(join(storeDir, "s20.jsonl"))).toBe(true);
  }, 60_000);

  test("never prunes the ref of the session doing the pruning", () => {
    // Resuming a session that has fallen outside the newest 20 used to delete its own ref and
    // then gc: the resumed session started a fresh root chain, and everything it had snapshotted
    // before went unreachable while its log went on listing those commits.
    mkdirSync(storeDir, { recursive: true });
    const gitDir = join(storeDir, "git");
    initShadow(gitDir);

    // The resumed session's own ref goes in first, so oldest-first puts it at the head of the
    // deletion list.
    writeFileSync(join(workTree, "a.txt"), "session own\n");
    const ownCommit = commitTree(gitDir, workTree, writeTree(gitDir, workTree));
    updateRef(gitDir, `refs/seri/sessions/${SESSION}`, ownCommit);
    for (let i = 0; i < 21; i++) {
      writeFileSync(join(workTree, "a.txt"), `session ${i}\n`);
      updateRef(
        gitDir,
        `refs/seri/sessions/s${String(i).padStart(2, "0")}`,
        commitTree(gitDir, workTree, writeTree(gitDir, workTree)),
      );
    }
    // Seed a log so the resumed session is resuming rather than starting.
    writeFileSync(join(storeDir, `${SESSION}.jsonl`), "");

    checkpointer()(mutation({ toolCallId: "c1" }));

    expect(listSessionRefs(gitDir)).toContain(`refs/seri/sessions/${SESSION}`);
    // The new checkpoint extends the chain it resumed rather than rooting a new one.
    const commit = toolRecords()[0]?.commit ?? "";
    expect(plainGit(gitDir, ["rev-list", commit]).split("\n").filter(Boolean)).toContain(ownCommit);
  }, 60_000);
});
