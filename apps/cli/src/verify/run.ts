import { spawnCollect as spawnCollectReal } from "../tools/spawnCollect";
import { parseDiagnostics, type Diagnostic } from "./parse";

// A broken build emits hundreds of diagnostics and they would otherwise dominate the context
// window for every subsequent turn. `total` is reported alongside, so a capped list can never be
// mistaken for the whole one.
export const MAX_DIAGNOSTICS = 20;

// Enough of the output to diagnose a checker that failed for a reason this parser cannot read —
// a missing script, a crashed compiler — without pasting a whole build log into the conversation.
const RAW_TAIL_CHARS = 600;

export type CheckOutcome =
  | { status: "ok"; command: string; elapsedMs: number }
  | {
      status: "diagnostics";
      command: string;
      elapsedMs: number;
      diagnostics: Diagnostic[];
      truncated: boolean;
      total: number;
    }
  // No command is configured. The default for every user, and it costs nothing: nothing is spawned.
  | { status: "unavailable"; reason: string }
  // The check itself broke — timeout, spawn error, or an exit code with output this parser could
  // not read. Deliberately never folded into "ok": a checker seri cannot understand must not come
  // back as a green build.
  | { status: "failed"; reason: string };

export type RunCheckOptions = { spawn?: typeof spawnCollectReal };

function tail(text: string): string {
  return text.length > RAW_TAIL_CHARS ? text.slice(-RAW_TAIL_CHARS) : text;
}

// `signal` is a required positional rather than a field of the options bag: the options bag is
// test injection, and burying the signal in it is how a caller ends up not passing one at all.
export async function runCheck(
  command: string | undefined,
  signal: AbortSignal | undefined,
  options: RunCheckOptions = {},
): Promise<CheckOutcome> {
  if (command === undefined) {
    return { status: "unavailable", reason: "no check command configured (set SERI_VERIFY_COMMAND)" };
  }

  // A plain whitespace split. It does NOT handle quoted arguments or escapes — `tsc --noEmit` and
  // `bun run typecheck` work, `sh -c "a b"` does not, and a path containing a space will be split
  // in the middle. Writing a shell-grammar parser to fix that would be a larger and more
  // error-prone thing than the feature it serves; the user who set this string can avoid spaces.
  const [executable, ...args] = command.trim().split(/\s+/);

  // spawnCollect takes no `cwd`, so the command runs in seri's own working directory. That is the
  // user's business rather than a hidden default, because the user wrote the command: it is the
  // same directory their shell was in when they started seri.
  const startedAt = Date.now();

  let result;
  try {
    result = await (options.spawn ?? spawnCollectReal)(executable, args, undefined, signal);
  } catch (err) {
    // Includes the "cancelled" rejection spawnCollect raises when the signal fires. Not re-thrown:
    // the write this check follows has already happened, and throwing here would hand the model a
    // tool error for a file that is on disk.
    return { status: "failed", reason: `${command} could not be run: ${err instanceof Error ? err.message : String(err)}` };
  }

  const elapsedMs = Date.now() - startedAt;

  if (result.timedOut) {
    return { status: "failed", reason: `${command} timed out after ${elapsedMs} ms` };
  }

  // Both streams: tsc prints diagnostics on stdout, but a package manager wrapping it can put them
  // on stderr, and reading only one is how a real error becomes a silent pass.
  const all = parseDiagnostics(`${result.stdout}\n${result.stderr}`);

  if (all.length === 0) {
    if (result.exitCode === 0) return { status: "ok", command, elapsedMs };
    return {
      status: "failed",
      reason: `${command} exited ${result.exitCode} with no output this parser could read: ${tail(result.stderr || result.stdout)}`,
    };
  }

  return {
    status: "diagnostics",
    command,
    elapsedMs,
    diagnostics: all.slice(0, MAX_DIAGNOSTICS),
    truncated: result.stdoutTruncated || result.stderrTruncated,
    total: all.length,
  };
}
