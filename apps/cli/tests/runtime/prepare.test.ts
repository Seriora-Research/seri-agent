import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { loadAgentsFile } from "../../src/agents/loadAgentsFile";
import { loadVerifyConfig } from "../../src/config/config";
import { buildCheckpointedTools, loadOrCreateSession } from "../../src/runtime/prepare";

const execOpts: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "test-call",
  messages: [],
  context: {},
};

let dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-prepare-cwd-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("explicit session cwd", () => {
  test("a new session records the injected cwd, not process.cwd()", () => {
    const sessionDir = makeDir();
    const configDir = makeDir();
    const original = process.cwd();
    const { session } = loadOrCreateSession(
      false,
      undefined,
      join(configDir, "sessions"),
      loadAgentsFile,
      configDir,
      sessionDir,
      () => ({ skills: new Map(), rules: new Map() }),
    );
    expect(session.cwd).toBe(sessionDir);
    expect(session.cwd).not.toBe(original);
    expect(process.cwd()).toBe(original);
  });

  test("checkpointed tools read relative paths from the session cwd", async () => {
    const sessionDir = makeDir();
    const storeDir = makeDir();
    writeFileSync(join(sessionDir, "note.txt"), "from-session");
    const { tools } = buildCheckpointedTools({
      storeDir,
      worktree: sessionDir,
      sessionId: "sess",
      cwd: sessionDir,
      verifyConfig: loadVerifyConfig(sessionDir),
      onWarning: () => {},
    });
    const original = process.cwd();
    const contents = await tools.read_file.execute?.({ path: "note.txt" }, execOpts);
    expect(contents).toBe("from-session");
    expect(process.cwd()).toBe(original);
  });
});
