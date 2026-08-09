import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import {
  type CheckpointRecord,
  checkpointStoreDir,
  createCheckpointer,
  readLog,
} from "../../src/checkpoint/checkpoint";
import { isGitAvailable } from "../../src/checkpoint/shadowGit";
import type { SessionState } from "../../src/session/session";
import { decideModeCycle, decideRestore, decideRewind, decideUndo } from "../../src/tui/commands";

let root: string;
let storeDir: string;
let workTree: string;
let checkpointsDir: string;

const SESSION = "session-1";

function session(overrides: Partial<SessionState<ModelMessage>> = {}): SessionState<ModelMessage> {
  return {
    id: SESSION,
    cwd: workTree,
    systemPrompt: "",
    permissionMode: "approve-each",
    messages: [],
    ...overrides,
  };
}

function checkpointer() {
  return createCheckpointer({
    storeDir,
    worktree: workTree,
    sessionId: SESSION,
    onWarning: () => {},
  });
}

// decideUndo/decideRestore/decideRewind derive storeDir from `dirs.checkpointsDir` themselves
// (checkpointTarget, mirroring cli.ts) rather than taking storeDir directly, so the fixtures below
// must build their checkpoints under that same derived storeDir for the two to agree.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seri-tui-commands-test-"));
  checkpointsDir = join(root, "checkpoints");
  workTree = join(root, "work");
  mkdirSync(workTree, { recursive: true });
  writeFileSync(join(workTree, "a.txt"), "before\n");
  storeDir = checkpointStoreDir(checkpointsDir, workTree);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("decideModeCycle", () => {
  test("cycles the mode without mutating the session it was given", () => {
    const before = session({ permissionMode: "read-only" });
    const { next, message } = decideModeCycle(before);

    expect(before.permissionMode).toBe("read-only");
    expect(next.permissionMode).toBe("approve-each");
    expect(message).toBe(`Session ${SESSION}: permission mode is now approve-each`);
  });
});

describe.skipIf(!isGitAvailable())("decideUndo", () => {
  test("restores the previous file state and reports what changed", () => {
    const snapshot = checkpointer();
    snapshot({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });
    writeFileSync(join(workTree, "a.txt"), "after\n");
    snapshot({
      tool: "write_file",
      toolCallId: "c2",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 2,
    });

    const { next, plan, message } = decideUndo(session(), ["2"], {
      sessionsDir: join(root, "sessions"),
      checkpointsDir,
    });

    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    expect(plan.restored).toEqual(["a.txt"]);
    expect(message).toBe("Undid to checkpoint 2.");
    // The session itself is not mutated by an undo — only the filesystem changes.
    expect(next.messages).toEqual([]);
  }, 30_000);

  test("reports no change when the checkpoint is already the current state", () => {
    checkpointer()({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });

    const { message } = decideUndo(session(), ["1"], {
      sessionsDir: join(root, "sessions"),
      checkpointsDir,
    });

    expect(message).toBe("Already at checkpoint 1; no file changed.");
  }, 30_000);

  // M-5 regression: onPlan (undoFiles' own callback) has to fire BEFORE the restore/removal pass
  // mutates the worktree, matching output.ts's own documented guarantee on undoPlanLines ("before
  // the restore happens, not after") — restoring that for the console path is the whole reason
  // decideUndo accepts onPlan at all rather than hardcoding a no-op. Checked here by reading the
  // file's content from INSIDE the callback: at that point the file must still read "after", not
  // yet reverted to "before".
  test("onPlan fires with the plan before the restore mutates the worktree", () => {
    const snapshot = checkpointer();
    snapshot({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });
    writeFileSync(join(workTree, "a.txt"), "after\n");
    snapshot({
      tool: "write_file",
      toolCallId: "c2",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 2,
    });

    const seenDuringOnPlan: string[] = [];
    decideUndo(
      session(),
      ["2"],
      { sessionsDir: join(root, "sessions"), checkpointsDir },
      (plan) => {
        seenDuringOnPlan.push(readFileSync(join(workTree, "a.txt"), "utf8"));
        expect(plan.restored).toEqual(["a.txt"]);
      },
    );

    expect(seenDuringOnPlan).toEqual(["after\n"]);
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
  }, 30_000);
});

describe.skipIf(!isGitAvailable())("decideRestore", () => {
  test("restores the named commit and reports it", () => {
    const snapshot = checkpointer();
    snapshot({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });
    writeFileSync(join(workTree, "a.txt"), "after\n");
    snapshot({
      tool: "write_file",
      toolCallId: "c2",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 2,
    });

    const records = readLog(storeDir, SESSION).filter(
      (record): record is Extract<CheckpointRecord, { kind: "tool" }> => record.kind === "tool",
    );
    const firstCommit = records[0]?.commit ?? "";

    const { plan, message } = decideRestore(session(), [firstCommit], {
      sessionsDir: join(root, "sessions"),
      checkpointsDir,
    });

    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    expect(plan.restored).toEqual(["a.txt"]);
    expect(message).toBe(`Restored ${firstCommit}.`);
  }, 30_000);
});

describe.skipIf(!isGitAvailable())("decideRewind", () => {
  test("truncates the session's messages, touches no file, and reports what was dropped", () => {
    checkpointer()({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });

    const before = session({
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    });

    const { next, message } = decideRewind(before, [], {
      sessionsDir: join(root, "sessions"),
      checkpointsDir,
    });

    expect(next.messages).toEqual([{ role: "user", content: "one" }]);
    expect(before.messages).toHaveLength(3);
    expect(message).toBe(
      `Session ${SESSION}: dropped 2 message(s), 1 remain. No file was touched.`,
    );
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    expect(existsSync(join(workTree, "a.txt"))).toBe(true);
  }, 30_000);

  // Finding 9 (thermo-nuclear structural review, round 6): decideRewind itself no longer appends
  // the barrier — it hands back a `recordBarrier` closure for the CALLER to call after persisting
  // `next`, restoring the original (pre-TUI) saveSession-then-appendBarrier order. This is the
  // deferred half of that fix: the barrier must not exist in the log until recordBarrier() is
  // actually called, and must exist once it is.
  test("does not record the barrier until recordBarrier() is called", () => {
    checkpointer()({
      tool: "write_file",
      toolCallId: "c1",
      args: { path: join(workTree, "a.txt") },
      rewindTo: 1,
    });
    const before = session({
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
      ],
    });
    const dirs = { sessionsDir: join(root, "sessions"), checkpointsDir };

    const { recordBarrier } = decideRewind(before, [], dirs);

    expect(readLog(storeDir, SESSION).some((r) => r.kind === "rewind-barrier")).toBe(false);
    recordBarrier();
    expect(readLog(storeDir, SESSION).some((r) => r.kind === "rewind-barrier")).toBe(true);
  }, 30_000);
});
