import { resolve } from "node:path";
import { spawnCollect as spawnCollectReal } from "../tools/spawnCollect";
import type { CheckOutcome } from "./outcome";
import { parseDiagnostics } from "./parse";

// Re-exported so `CheckOutcome` is still reachable from the module that produces it. The type
// itself lives in outcome.ts, which the printer imports and which therefore must not reach
// spawnCollect — see the comment there.
export type { CheckOutcome } from "./outcome";

// A broken build emits hundreds of diagnostics and they would otherwise dominate the context
// window for every subsequent turn. `total` is reported alongside, so a capped list can never be
// mistaken for the whole one.
export const MAX_DIAGNOSTICS = 20;

// Enough of the output to diagnose a checker that failed for a reason this parser cannot read —
// a missing script, a crashed compiler — without pasting a whole build log into the conversation.
const RAW_TAIL_CHARS = 600;

export type RunCheckOptions = { spawn?: typeof spawnCollectReal };

function tail(text: string): string {
  return text.length > RAW_TAIL_CHARS ? text.slice(-RAW_TAIL_CHARS) : text;
}

// `signal` is a required positional rather than a field of the options bag: the options bag is
// test injection, and burying the signal in it is how a caller ends up not passing one at all.
export async function runCheck(
  command: string | undefined,
  writtenPath: string,
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

  // Parsed BEFORE the timeout is considered, which is the whole point of spawnCollect keeping what
  // a killed child managed to print (spawnCollect.ts:207-208). A typecheck that emitted 40 real
  // errors and was then cut off has told the model something true; discarding all of it to report
  // only "timed out" throws away the answer and keeps the complaint.
  //
  // Both streams: tsc prints diagnostics on stdout, but a package manager wrapping it can put them
  // on stderr, and reading only one is how a real error becomes a silent pass.
  const all = parseDiagnostics(`${result.stdout}\n${result.stderr}`);

  if (all.length === 0) {
    if (result.timedOut) return { status: "failed", reason: `${command} timed out after ${elapsedMs} ms` };
    if (result.exitCode === 0) return { status: "ok", command, elapsedMs };
    return {
      status: "failed",
      reason: `${command} exited ${result.exitCode} with no output this parser could read: ${tail(result.stderr || result.stdout)}`,
    };
  }

  // The file just written goes first, and the cap is applied AFTER the sort — so when a project
  // has 300 pre-existing errors, the model's own are the ones that survive the 20-diagnostic
  // budget instead of being crowded out by whichever files tsc happened to visit first.
  //
  // Both sides are resolved against seri's cwd because that is where the check ran and where
  // write_file wrote, so tsc's relative paths and the tool's path are relative to the same place.
  // Not case-folded: a path that differs only in case sorts as "elsewhere", which costs ordering
  // on a case-insensitive filesystem but never mislabels an unrelated file as the written one.
  const writtenAbsolute = resolve(writtenPath);
  const here = all.filter((diagnostic) => resolve(diagnostic.file) === writtenAbsolute);
  const elsewhere = all.filter((diagnostic) => resolve(diagnostic.file) !== writtenAbsolute);

  return {
    status: "diagnostics",
    command,
    elapsedMs,
    diagnostics: [...here, ...elsewhere].slice(0, MAX_DIAGNOSTICS),
    inWrittenFile: Math.min(here.length, MAX_DIAGNOSTICS),
    // A timeout counts as truncation because it means the same thing to a reader: this list is not
    // all of them. The check was killed part way, so every diagnostic it had not reached yet is
    // missing exactly as if the stream had been cut.
    truncated: result.stdoutTruncated || result.stderrTruncated || result.timedOut,
    total: all.length,
  };
}
