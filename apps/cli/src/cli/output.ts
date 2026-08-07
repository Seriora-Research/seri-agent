// What seri puts on the screen, and nothing else: every function here takes what it prints as an
// argument, so none of them can reach a session, a checkpoint store or the loop. That is what makes
// them testable without building a run — printEvent's `never` guard in particular, which is the
// file's compile-time contract with LoopEvent.
//
// The one value import is held to the same standard. `verify/outcome` exists precisely so this file
// can narrow a verified write_file result without reaching `verify/run` and, through it,
// `spawnCollect` — which imports `node:child_process` and registers a process-global signal handler
// at module load. Importing the printer must not do that, so keep any new import here dependency-
// free or the sentence above stops being true.
import type { RestorePlan, RestoreResult } from "../checkpoint/checkpoint";
import type { LoopEvent } from "../loop/loop";
import { writeFileVerification, type CheckOutcome } from "../verify/outcome";

// stdout and exit 0 for a served request, like --help. A bad invocation of seri itself — anything
// parseArgs rejects, or no task given — is a usage error: printed to stderr, exit 2.
// config/commands.ts's own usage error also exits 2, keeping the convention uniform across every
// subcommand rather than half-adopted on just this one.
// `--selftest` is left out on purpose — cli.ts calls it an undocumented build-verification flag.
export const USAGE = `Usage:
  seri <task>                     send a task to the model
  seri --continue [task]          continue the most recent session
  seri --resume <id> [task]       continue that session
  seri [--resume <id>] /mode      cycle the permission mode
  seri [--resume <id>] /undo [n] | /rewind [n] | /restore <sha>
  seri login | signup | logout
  seri config set|list|unset
  seri --version | --help

Options:
  --max-turns <n>                 stop after n model turns (default 500)
  --dangerously-skip-permissions  run every tool with no approval prompt (attended use only)
  --                              everything after this is the task, flags included:
                                    seri -- fix the --help output`;

// console.error(message), console.error(USAGE), return 2 — one helper because every usage error
// takes the same three steps, and USAGE is what names the -- escape: parseArgs' own message does,
// for an unknown option, but not for the "argument missing"/"argument is ambiguous" messages an
// optional value or a required-value option without one produce (measured) — so USAGE is appended
// unconditionally rather than only on the option that happens to name it already.
export function usageError(message: string): number {
  console.error(message);
  console.error(USAGE);
  return 2;
}

// stderr, not stdout: stdout carries the model's own output and is routinely piped, and a warning
// that a file will not be recoverable must not end up inside whatever consumed that pipe.
export function printWarning(message: string): void {
  console.error(`⚠ ${message}`);
}

// Printed before the restore happens, not after. Every path here comes from git's own output, so
// an ignored file can never appear under "restored" or "deleted"; the ones that were written and
// skipped are listed separately rather than left for the user to notice was missing. The deletion
// list matters most: the removal pass takes every untracked, non-ignored file, including ones a
// human made by hand in another terminal.
export function printUndoPlan(plan: RestorePlan): void {
  if (plan.diff) console.log(plan.diff);
  for (const path of plan.restored) console.log(`restored ${path}`);
  for (const path of plan.deleted) console.log(`deleted  ${path}`);
  if (plan.ignored.length > 0) console.log(`not restored (gitignored): ${plan.ignored.join(", ")}`);
}

// Restoring is never the operation that loses work: the state it just replaced was committed first.
export function printRecovery(result: RestoreResult): void {
  console.log(`The state this replaced is commit ${result.preUndoCommit}. To get it back:`);
  console.log(`  ${result.recoverCommand}`);
}

// The per-write cost is the whole reason `verify.enabled` exists, and a user deciding whether to
// turn the feature off cannot weigh a number they were never shown.
function seconds(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

// What a verified write_file adds to its "done" line, or "" when there is nothing to say.
//
// `unavailable` deliberately prints nothing: no command configured is the default for every user
// and disabling it is an explicit choice, so neither is news, and a line on every single write
// would be pure noise. `failed` is the opposite — a check that RAN and broke, most often a typo in
// SERI_VERIFY_COMMAND, which otherwise costs a spawn per write and reports itself only to the
// model. It is the one case that must not read as a clean run.
//
// The count is `total`, never `diagnostics.length`: the list is capped at MAX_DIAGNOSTICS, so the
// length is what survived the cap and the total is what the check actually found. When they differ
// the cap is stated outright rather than left to be inferred from a suspiciously round number.
function verificationSuffix(verification: CheckOutcome): string {
  switch (verification.status) {
    case "ok":
      return ` (checked in ${seconds(verification.elapsedMs)}, no diagnostics)`;
    case "diagnostics": {
      const shown = verification.diagnostics.length;
      const count = shown < verification.total ? `${shown} of ${verification.total}` : `${verification.total}`;
      const noun = verification.total === 1 ? "diagnostic" : "diagnostics";
      const incomplete = verification.truncated ? ", list incomplete" : "";
      return ` (${count} ${noun} in ${seconds(verification.elapsedMs)}${incomplete})`;
    }
    case "failed":
      return ` — check failed: ${verification.reason}`;
    case "unavailable":
      return "";
  }
}

export function printEvent(event: LoopEvent): void {
  switch (event.type) {
    case "text-delta":
      process.stdout.write(event.text);
      break;
    case "tool-call":
      console.log(`\n→ ${event.name}(${JSON.stringify(event.args)})`);
      break;
    case "tool-result": {
      // `edit` returns the edited text and writes nothing (provider/tools.ts's
      // FS_MUTATING_TOOL_NAMES comment), so a bare "done" reads as a file that changed — observed
      // live, with the model moving on as though it had. Named here rather than in the loop, which
      // knows no tool names by design.
      //
      // The verification suffix is NOT named that way: the narrowing belongs to the module that
      // produces the shape, so this file asks it rather than re-deriving it, and `edit` stays the
      // only tool name here.
      const verification = writeFileVerification(event.result);
      console.log(
        event.name === "edit"
          ? "✓ edit done (text returned, nothing written)"
          : `✓ ${event.name} done${verification === undefined ? "" : verificationSuffix(verification)}`,
      );
      break;
    }
    case "permission-denied":
      console.log(`✗ ${event.name} blocked`);
      break;
    // Printed because a grant the user cannot see is a grant they cannot revoke. "for this run" is
    // the persistence decision — keep this string matching what actually happens.
    case "tool-allowed":
      console.log(`✓ ${event.name} approved for the rest of this run`);
      break;
    case "compacted":
      console.log(`\n⚙ compacted ${event.evictedCount} messages`);
      break;
    // A rate limit or a 5xx, and there is no telling which from here: the SDK hands its retry
    // callback neither the error nor the delay (compaction.ts's MAX_RETRIES comment), so naming one of
    // the two would be a guess printed as a fact. Worth a line at all because the wait is the SDK's
    // — 2 s before the first re-issue — and until now a rate-limited turn simply looked hung.
    case "retry":
      console.log(`\n↻ rate-limited or unavailable; retrying (attempt ${event.attempt})`);
      break;
    // Deliberately silent per event: the loop emits one of these per completed model call, so
    // printing here would put a token count between every turn and its successor. driveLoop sums
    // them instead and run() prints the one line at the end.
    case "usage":
      break;
    // Never actually reaches here — driveLoop persists the session and `continue`s on it — and it
    // has no rendering if it ever does: the message array is the session's business, not the
    // screen's. Spelled out rather than left to the default below, because "this event prints
    // nothing" is a decision and the default is where an undecided one gets caught.
    case "messages-updated":
      break;
    case "done":
      console.log(`\n(done: ${event.reason})`);
      // The one reason whose fix is a command the user has to type. `max-iterations` and
      // `no-tool-call` need no follow-up and `aborted` was the user's own doing.
      if (event.reason === "repeated-denials") {
        // Neither half of this can name a single fix: the streak can span different tools
        // (write_file, edit, bash), not just one, and "answer 'a' at the prompt" is only true in
        // approve-each — read-only never prompts at all, and read-only is the mode most likely to
        // have produced this stop.
        console.log("Several write calls were refused in a row, so the run stopped. Run /mode to");
        console.log("change the permission mode (or, in approve-each, answer 'a' at the prompt).");
      }
      break;
    case "error":
      console.error(event.error);
      break;
    // Every LoopEvent member is handled above, so nothing reaches this at runtime. Not all of them
    // were before this line was written — adding it is what showed that `messages-updated` had no case
    // at all. It exists for the next one: `usage` and `retry` were both added to the union here and both
    // would have fallen through this switch in silence, which for a user-facing event means it was
    // simply never printed. `never` is what makes tsc say so at the point the member is added
    // rather than leaving it to be noticed in a session. Compile-time only, with no throw: nothing
    // can reach this at runtime, and a printer is the last thing that should be able to end a run.
    default: {
      const _unhandled: never = event;
      break;
    }
  }
}

// What the run cost, summed by the consumer rather than in runLoop: the loop is stateless by design
// and emits one usage event per completed model call, so the running total is the consumer's to keep.
//
// `undefined` rather than 0 for "the provider never told us", and the two halves are tracked
// separately because a provider can report one and not the other: LanguageModelUsage types both as
// optional, and `?? 0` turned a missing outputTokens into the printed claim "0 out" — a
// measurement of a number nobody measured. 0 stays available for the other meaning, a call that
// really did report zero.
export type RunUsage = { inputTokens: number | undefined; outputTokens: number | undefined };

// Only what was actually reported. A run that made no model call — a provider that failed before
// the first request — has no spend, and "(tokens: 0 in, 0 out)" is a number the user cannot act on
// printed on paths that never called anything; that run prints no line at all. A provider that
// reports input tokens and not output ones prints only the half it gave, because "0 out" reads as a
// measurement and there was no measurement: a provider omitting the field and a call that genuinely
// produced nothing are not the same fact, and the summary is the wrong place to guess which. A
// reported 0 still prints — that one IS a measurement.
//
// Leading "\n" for the same reason printEvent's terminal `done` line carries one: the model's text
// arrives through process.stdout.write with no trailing newline, and on the path this summary was
// built for — a call that streamed text and then failed — there is no `done` event to end that
// line, because the error goes to stderr. Measured without it, on raw stdout:
// "partial answer(tokens: 900 in, 7 out)\n", i.e. a consumer piping stdout for the answer got the
// token count welded onto its last line. Unconditional rather than only on that path: every other
// exit ends with the `done` line, whose own leading "\n" already puts a blank line before it, so
// this is the spacing the rest of the run's output already has.
export function printUsage(usage: RunUsage): void {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${usage.inputTokens} in`);
  if (usage.outputTokens !== undefined) parts.push(`${usage.outputTokens} out`);
  if (parts.length === 0) return;
  console.log(`\n(tokens: ${parts.join(", ")})`);
}
