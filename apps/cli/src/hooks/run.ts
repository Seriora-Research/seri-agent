import { isBashAvailable, resolveBashCommand } from "../tools/bash";
import { spawnCollect } from "../tools/spawnCollect";
import { HOOK_BLOCK_EXIT_CODE, type HookOutcome, type HookPayload, type HookSpec } from "./types";
import { messageOf } from "../errors";

// spawnCollect's own 30,000-char cap exists for a tool result the model can read in full and act
// on. A hook's reason or failure message is not that — it is a one-line denial or a "this could not
// run" note that has to sit next to the rest of the transcript on every future turn, so it gets a
// budget an order of magnitude smaller rather than inheriting the tool-output one.
const REASON_MAX_CHARS = 300;

function truncate(text: string): string {
  return text.length > REASON_MAX_CHARS ? `${text.slice(0, REASON_MAX_CHARS)}…` : text;
}

function blockReason(spec: HookSpec, stderr: string): string {
  const trimmed = stderr.trim();
  // A script that blocks silently is still a block the model has to explain to the user, and an
  // empty reason would leave it nothing to say.
  return truncate(trimmed || `${spec.script} blocked the call but printed nothing on stderr`);
}

function failureMessage(spec: HookSpec, cause: string, stderr: string): string {
  const trimmed = stderr.trim();
  return truncate(trimmed ? `${spec.script} ${cause}: ${trimmed}` : `${spec.script} ${cause}`);
}

// win32 → powershell.exe with the same flags .cursor/hooks.json already runs these scripts under.
// Elsewhere → whatever bash bash.ts resolved (Git Bash on a PATH-less Windows counts as win32
// here, not "elsewhere" — this is process.platform, not a bash-vs-powershell content check).
function resolveInterpreter(spec: HookSpec): { executable: string; args: string[] } | undefined {
  if (process.platform === "win32") {
    return { executable: "powershell.exe", args: ["-NonInteractive", "-NoProfile", "-File", spec.path] };
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
  const interpreter = resolveInterpreter(spec);
  if (interpreter === undefined) {
    return { kind: "failed", message: truncate(`${spec.script}: bash is not available on this system`) };
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
    // A cancelled hook is not this function's decision to make sense of — the loop's own
    // cancellation path already knows how to unwind a rejected tool call, and duplicating that
    // here would be a second, divergent way of handling the same event.
    if (signal?.aborted === true) throw err;
    return { kind: "failed", message: truncate(`${spec.script} could not be run: ${messageOf(err)}`) };
  }

  if (result.timedOut) {
    return { kind: "failed", message: failureMessage(spec, "timed out", result.stderr) };
  }
  if (result.exitCode === 0) return { kind: "ok" };
  if (result.exitCode === HOOK_BLOCK_EXIT_CODE) {
    return { kind: "block", reason: blockReason(spec, result.stderr) };
  }
  return { kind: "failed", message: failureMessage(spec, `exited ${result.exitCode}`, result.stderr) };
}
