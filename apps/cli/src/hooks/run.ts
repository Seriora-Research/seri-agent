import { existsSync } from "node:fs";
import { messageOf } from "../errors";
import { isBashAvailable, resolveBashCommand } from "../tools/bash";
import { spawnCollect } from "../tools/spawnCollect";
import {
  HOOK_BLOCK_EXIT_CODE,
  HOOK_REASON_MAX_CHARS,
  type HookOutcome,
  type HookPayload,
  type HookSpec,
} from "./types";

function truncate(text: string): string {
  if (text.length <= HOOK_REASON_MAX_CHARS) return text;
  // The cause is usually the last line of stderr.
  return `…${text.slice(-(HOOK_REASON_MAX_CHARS - 1))}`;
}

function blockReason(spec: HookSpec, stderr: string): string {
  const trimmed = stderr.trim();

  return truncate(trimmed || `${spec.script} blocked the call but printed nothing on stderr`);
}

function failureMessage(spec: HookSpec, cause: string, stderr: string): string {
  const trimmed = stderr.trim();
  return truncate(trimmed ? `${spec.script} ${cause}: ${trimmed}` : `${spec.script} ${cause}`);
}

function resolveInterpreter(spec: HookSpec): { executable: string; args: string[] } | undefined {
  // win32 → powershell.exe. Git Bash on Windows is still win32 here (process.platform).
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", spec.path],
    };
  }
  if (!isBashAvailable()) return undefined;
  return { executable: resolveBashCommand(), args: [spec.path] };
}

export async function runHook(
  spec: HookSpec,
  payload: HookPayload,
  signal?: AbortSignal,
  spawn: typeof spawnCollect = spawnCollect,
): Promise<HookOutcome> {
  // A shell "not found" exit means the hook started. A missing script never did.
  if (!existsSync(spec.path)) {
    return {
      kind: "unrunnable",
      message: truncate(`${spec.script} could not be run: no such file`),
    };
  }

  const interpreter = resolveInterpreter(spec);
  if (interpreter === undefined) {
    return {
      kind: "unrunnable",
      message: truncate(`${spec.script}: bash is not available on this system`),
    };
  }

  let result: Awaited<ReturnType<typeof spawnCollect>>;
  try {
    result = await spawn(
      interpreter.executable,
      interpreter.args,
      spec.timeoutMs,
      signal,
      payload.cwd,
      JSON.stringify(payload),
    );
  } catch (err) {
    if (signal?.aborted === true) throw err;
    return {
      kind: "unrunnable",
      message: truncate(`${spec.script} could not be run: ${messageOf(err)}`),
    };
  }

  if (result.timedOut) {
    return { kind: "failed", message: failureMessage(spec, "timed out", result.stderr) };
  }
  if (result.exitCode === 0) return { kind: "ok" };
  if (result.exitCode === HOOK_BLOCK_EXIT_CODE) {
    return { kind: "block", reason: blockReason(spec, result.stderr) };
  }
  return {
    kind: "failed",
    message: failureMessage(spec, `exited ${result.exitCode}`, result.stderr),
  };
}
