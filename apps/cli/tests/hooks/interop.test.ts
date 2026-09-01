import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runHook } from "../../src/hooks/run";
import { DEFAULT_HOOK_TIMEOUT_MS, type HookSpec } from "../../src/hooks/types";

// This repo's own `.cursor/hooks/` is what plan-10a names as the reference implementation, so it is
// the honest test of the claim that a script written for another harness runs here unchanged. It is
// also the test that caught the payload envelope being wrong: the `.sh` half greps the raw JSON
// text and passes under almost any field names, while the `.ps1` half does
// `($payload | ConvertFrom-Json).tool_input.command` and silently found nothing, returning "ok" for
// `rm -rf /`. Only the structural reader could tell.
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
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    source: "project",
    filePath: join(HOOK_DIR, "hooks.yaml"),
  };
}

// A checkout without `.cursor/` is a valid checkout, and a missing reference implementation is not
// this feature's failure. Skipped rather than failed, and named so a skip is visible.
const describeIfPresent = existsSync(blockDangerous) ? describe : describe.skip;

describeIfPresent("the reference hooks in .cursor/hooks/ run under seri unchanged", () => {
  // powershell.exe cold-start on Windows CI can exceed bun's default 5s test timeout
  // (measured: this test hit 5001ms then reported kind "failed"; the next hook in the
  // same file then passed at 4318ms). Same 15000ms margin tools/powershell.test.ts
  // already uses for the identical spawn.
  const hookTimeoutMs = 15_000;

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
    hookTimeoutMs,
  );

  // The negative control above is what makes this one mean anything: a runner that blocked
  // everything would pass this test and fail that one.
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
    hookTimeoutMs,
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
    hookTimeoutMs,
  );
});
