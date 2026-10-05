import { accessSync, constants, statSync } from "node:fs";
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

function unrunnableFileReason(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return "not a regular file";
    accessSync(path, constants.R_OK);
    return undefined;
  } catch (err) {
    const code = err !== null && typeof err === "object" && "code" in err ? err.code : undefined;
    return code === "ENOENT" ? "no such file" : "not a readable file";
  }
}

function truncate(text: string): string {
  if (text.length <= HOOK_REASON_MAX_CHARS) return text;
  // The cause is usually the last line of stderr.
  return `…${text.slice(-(HOOK_REASON_MAX_CHARS - 1))}`;
}

function excerpt(stderr: string): string {
  return truncate(stderr.trim());
}

function blockReason(spec: HookSpec, stderr: string): string {
  return excerpt(stderr) || `${spec.script} blocked the call but printed nothing on stderr`;
}

function failureMessage(spec: HookSpec, cause: string, stderr: string): string {
  const body = excerpt(stderr);
  return body ? `${spec.script} ${cause}: ${body}` : `${spec.script} ${cause}`;
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
  // A shell "not found" exit means the hook started. A missing, unreadable, or
  // directory path never did (bash would still exec a directory and exit 126).
  const fileReason = unrunnableFileReason(spec.path);
  if (fileReason !== undefined) {
    return {
      kind: "unrunnable",
      message: truncate(`${spec.script} could not be run: ${fileReason}`),
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
