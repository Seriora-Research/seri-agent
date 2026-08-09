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
import { applyModeCycle, applyRestore, applyRewind, applyUndo } from "../../src/tui/commands";

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

// applyUndo/applyRestore/applyRewind derive storeDir from `dirs.checkpointsDir` themselves
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

describe("applyModeCycle", () => {
  test("cycles the mode without mutating the session it was given", () => {
    const before = session({ permissionMode: "read-only" });
    const { next, message } = applyModeCycle(before);

    expect(before.permissionMode).toBe("read-only");
    expect(next.permissionMode).toBe("approve-each");
    expect(message).toBe(`Session ${SESSION}: permission mode is now approve-each`);
  });
});

describe.skipIf(!isGitAvailable())("applyUndo", () => {
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

    const { next, plan, message } = applyUndo(session(), ["2"], {
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

    const { message } = applyUndo(session(), ["1"], {
      sessionsDir: join(root, "sessions"),
      checkpointsDir,
    });

    expect(message).toBe("Already at checkpoint 1; no file changed.");
  }, 30_000);
});

describe.skipIf(!isGitAvailable())("applyRestore", () => {
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

    const { plan, message } = applyRestore(session(), [firstCommit], {
      sessionsDir: join(root, "sessions"),
      checkpointsDir,
    });

    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
    expect(plan.restored).toEqual(["a.txt"]);
    expect(message).toBe(`Restored ${firstCommit}.`);
  }, 30_000);
});

describe.skipIf(!isGitAvailable())("applyRewind", () => {
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

    const { next, message } = applyRewind(before, [], {
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
});
