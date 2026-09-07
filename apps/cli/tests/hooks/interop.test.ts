import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runHook } from "../../src/hooks/run";
import { DEFAULT_HOOK_TIMEOUT_MS, type HookSpec } from "../../src/hooks/types";







const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const HOOK_DIR = join(REPO_ROOT, ".cursor", "hooks");

const ext = process.platform === "win32" ? "ps1" : "sh";
const blockDangerous = join(HOOK_DIR, `block-dangerous.${ext}`);
const blockEnvRead = join(HOOK_DIR, `block-env-read.${ext}`);

function spec(path: string): HookSpec {
  return {
    event: "PreToolUse",
    script: "block-dangerous",
    path,
    matcher: undefined,


    timeoutMs: process.platform === "win32" ? 15_000 : DEFAULT_HOOK_TIMEOUT_MS,
    source: "project",
    filePath: join(HOOK_DIR, "hooks.yaml"),
  };
}

const TEST_TIMEOUT_MS = process.platform === "win32" ? 20_000 : 5_000;



const describeIfPresent = existsSync(blockDangerous) ? describe : describe.skip;

describeIfPresent("the reference hooks in .cursor/hooks/ run under seri unchanged", () => {
  test(
    "an ordinary command is allowed",
    async () => {
      const outcome = await runHook(spec(blockDangerous), {
        hook_event_name: "PreToolUse",
        tool_name: "bash",
        cwd: REPO_ROOT,
        tool_input: { command: "git status" },
      });
      expect(outcome.kind).toBe("ok");
    },
    TEST_TIMEOUT_MS,
  );



  test(
    "rm -rf / is blocked, and the script's own stderr is the reason",
    async () => {
      const outcome = await runHook(spec(blockDangerous), {
        hook_event_name: "PreToolUse",
        tool_name: "bash",
        cwd: REPO_ROOT,
        tool_input: { command: "rm -rf /" },
      });
      expect(outcome.kind).toBe("block");
      if (outcome.kind !== "block") return;
      expect(outcome.reason).toContain("BLOCKED");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a .env read is blocked through the file_path field, not the command one",
    async () => {
      const outcome = await runHook(spec(blockEnvRead), {
        hook_event_name: "PreToolUse",
        tool_name: "read_file",
        cwd: REPO_ROOT,
        tool_input: { file_path: join(REPO_ROOT, ".env") },
      });
      expect(outcome.kind).toBe("block");
    },
    TEST_TIMEOUT_MS,
  );
});
