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
import type { ArchivistReport } from "../memory/archivist";
import type { CostReport } from "../provider/cost";
import type { DispatchResult } from "../subagents/dispatch";
import { type CheckOutcome, writeFileVerification } from "../verify/outcome";

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
  /model (inside the TUI)         open the model picker — not a seri subcommand, same reasoning
                                    as /exit below: there is no picker to open outside a live TUI
  /setup (inside the TUI)         add, replace or remove a provider API key — not a seri
                                    subcommand; seri config set is the non-interactive equivalent
  seri [--resume <id>] /undo [n] | /rewind [n] | /restore <sha>
  seri [--resume <id>] /memory pending | diff <id|all> | approve <id|all> | reject <id|all>
                                    | approval on|off | archivist on|off
  /exit (inside the TUI)          end the session, or Ctrl-D — not a seri subcommand: it means
                                    nothing outside a live TUI, and "seri /exit" is just a task
  seri login | signup | logout
  seri config set|list|unset
  seri permissions list|remove <tool>
  seri --version | --help

Options:
  --max-turns <n>                 stop after n model turns (default 500)
  --profile <name>                use the named profile's config, auth, permissions, sessions
                                    and checkpoints (or SERI_PROFILE; the flag wins)
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

// Defence-in-depth, not a live threat today: this file renders a tool name at two sites — the
// approval prompt (cli.ts) and the tool-allowed line below — and both are reached only when
// `checkPermission` returns `needs-approval`/`allow-new`, which requires `WRITE_TOOLS.has(name)`
// (gate.ts). That means the name at both sites is always one of the fixed `WRITE_TOOL_NAMES`
// strings today, never model-invented — a model that names a tool anything else takes the early
// "allow" return in checkPermission and never reaches either render site. Kept anyway, cheaply,
// for the day `WRITE_TOOL_NAMES` grows a name that is not a compile-time constant (an MCP-provided
// write tool, say): a newline or an ANSI escape sequence in THAT name could scroll real output
// off-screen or paint a fake line, and this is what would stop it. Only control characters and DEL
// are escaped, not the whole name the way a prompt's `args` are already wrapped in JSON.stringify:
// a legitimate name is always a plain identifier (write_file, bash, …), and stringifying it would
// put visible quotes on every single render for a case that, today, cannot happen at all.
export function escapeControlChars(text: string): string {
  return text.replace(
    /[\x00-\x1f\x7f]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

// write_file's input carries the whole file body, so an uncapped JSON.stringify can render
// hundreds of lines on one prompt line and scroll the question itself out of scrollback before the
// user can even see it, let alone answer it. Capped, not omitted: the prompt's job is still to
// show what is about to happen, just not all of it when "all of it" is unreadable anyway. Used by
// cli.ts's own approval prompt and by App.tsx's live pending-tool box (Ink's TUI) — the two render
// sites that show `write_file`/`edit`'s own args, whole-file-body carrying tools both.
const MAX_PROMPT_ARGS_LENGTH = 200;
export function truncateArgsDisplay(args: unknown): string {
  // JSON.stringify(undefined) returns `undefined` (the value, not a string), and `.length` on
  // that throws inside this Promise executor — which rejects approvalPrompt, which nothing in
  // runLoop wraps, so it would escape driveLoop as an unhandled rejection, skipping printUsage and
  // the exit-code logic entirely. Unreachable through cli.ts today (call.input is provider-parsed
  // JSON, never bare undefined), but ApprovalPrompt is an exported seam Stage 11's Ink prompt
  // re-implements against, and `args: unknown` promises nothing about what a future caller passes.
  const json = JSON.stringify(args) ?? "undefined";
  return json.length > MAX_PROMPT_ARGS_LENGTH ? `${json.slice(0, MAX_PROMPT_ARGS_LENGTH)}…` : json;
}

// Round 7 code review: this line was written out twice — once in makeApprovalPrompt's own
// rl.question call (cli.ts), once in App.tsx's ApprovalBox — exactly the drift risk
// toolResultLine/toolAllowedLine (below) already exist to prevent elsewhere. One shared function
// instead, used by both. `offersAlways` gates the "[a]lways" option — PERSISTABLE_TOOLS decides
// it at each call site, not here, so this file stays free of a permissions/store.ts import.
export function approvalPromptText(toolName: string, args: unknown, offersAlways: boolean): string {
  return `Approve ${escapeControlChars(toolName)}(${truncateArgsDisplay(args)})? ${
    offersAlways ? "[y]es / [a]lways (saved for this project) / [N]o" : "[y]es / [N]o"
  } `;
}

// stderr, not stdout: stdout carries the model's own output and is routinely piped, and a warning
// that a file will not be recoverable must not end up inside whatever consumed that pipe.
export function printWarning(message: string): void {
  console.error(`⚠ ${message}`);
}

// The second half of what an "always" answer now does. Printed only when a grant was actually
// written — driveLoop calls this on rememberGrant's `true`, never unconditionally — so it can
// never claim a persistence that the store refused (a non-persistable name, an unparseable file).
export function printGrantPersisted(name: string, worktree: string): void {
  console.log(
    `  saved for ${worktree} — undo with: seri permissions remove ${escapeControlChars(name)}`,
  );
}

// A grant the user cannot see is a grant they cannot revoke, and a grant made weeks ago in another
// session is exactly the invisible kind. One line at the start of the run that would otherwise
// silently skip a prompt.
export function printPreApproved(tools: readonly string[]): void {
  console.log(
    `Pre-approved without asking: ${tools.map(escapeControlChars).join(", ")} — seri permissions list`,
  );
}

// One line-shape, one place: cli.ts's consolePresenter and tuiPresenter both call this — the
// former via its own default `console.log` sink, the latter with a sink that dispatches a
// transcript-append action per line — instead of each hand-copying the same
// restored/deleted/ignored template, which can drift out of sync the moment one of them changes
// and the other does not.
//
// Called before the restore happens, not after. Every path here comes from git's own output, so
// an ignored file can never appear under "restored" or "deleted"; the ones that were written and
// skipped are listed separately rather than left for the user to notice was missing. The deletion
// list matters most: the removal pass takes every untracked, non-ignored file, including ones a
// human made by hand in another terminal.
export function undoPlanLines(plan: RestorePlan, sink: (line: string) => void = console.log): void {
  if (plan.diff) sink(plan.diff);
  for (const path of plan.restored) sink(`restored ${path}`);
  for (const path of plan.deleted) sink(`deleted  ${path}`);
  if (plan.ignored.length > 0) sink(`not restored (gitignored): ${plan.ignored.join(", ")}`);
}

// Restoring is never the operation that loses work: the state it just replaced was committed first.
export function recoveryLines(
  result: RestoreResult,
  sink: (line: string) => void = console.log,
): void {
  sink(`The state this replaced is commit ${result.preUndoCommit}. To get it back:`);
  sink(`  ${result.recoverCommand}`);
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
      const count =
        shown < verification.total ? `${shown} of ${verification.total}` : `${verification.total}`;
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

// Finding 7 (thermo-nuclear structural review, round 6): reducer.ts's own applyLoopEvent (Ink's
// TUI transcript) used to reimplement these two line shapes by hand instead of sharing them, and
// had drifted — missing the `edit`-specific message and the verification suffix on tool-result,
// missing escapeControlChars on tool-allowed's tool name. Extracted so the two paths render the
// SAME line, the same way undoPlanLines/recoveryLines already do for /undo and /restore, rather
// than needing another audit the next time either drifts again.
//
// `edit` returns the edited text and writes nothing (provider/tools.ts's FS_MUTATING_TOOL_NAMES
// comment), so a bare "done" reads as a file that changed — observed live, with the model moving
// on as though it had. Named here rather than in the loop, which knows no tool names by design.
//
// The verification suffix is NOT named that way: the narrowing belongs to the module that
// produces the shape, so this file asks it rather than re-deriving it, and `edit` stays the only
// tool name here.
// `DispatchResult` above is a type-only import, so nothing from subagents/ is actually loaded at
// runtime — this file already type-imports the heavier loop.ts for LoopEvent (above) the same way,
// so the header comment's "keep imports dependency-free" rule is about VALUE imports, not this one.
// Still narrowed rather than trusted outright: `result` is `unknown` on the wire (loop.ts types
// every tool result that way), so the cast is a shape assertion, not a guarantee.
function dispatchSummary(
  result: unknown,
): { ran: number; total: number; tokens: number | undefined } | undefined {
  const value = result as Partial<DispatchResult> | undefined;
  if (!Array.isArray(value?.results)) return undefined;
  const ran = value.results.filter((r) => r.doneReason !== undefined).length;
  const tokens = value.totalUsage?.totalTokens;
  return {
    ran,
    total: value.results.length,
    tokens: typeof tokens === "number" ? tokens : undefined,
  };
}

export function toolResultLine(event: Extract<LoopEvent, { type: "tool-result" }>): string {
  if (event.name === "edit") return "✓ edit done (text returned, nothing written)";
  const dispatch = event.name === "dispatch_subagents" ? dispatchSummary(event.result) : undefined;
  if (dispatch !== undefined) {
    const tokens = dispatch.tokens === undefined ? "" : `, ${dispatch.tokens} tokens`;
    const tasks =
      dispatch.ran === dispatch.total
        ? `${dispatch.total} ${dispatch.total === 1 ? "task" : "tasks"}`
        : `${dispatch.ran} of ${dispatch.total} tasks`;
    return `✓ dispatch_subagents done (${tasks}${tokens})`;
  }
  const verification = writeFileVerification(event.result);
  return `✓ ${event.name} done${verification === undefined ? "" : verificationSuffix(verification)}`;
}

// Printed because a grant the user cannot see is a grant they cannot revoke. This string is still
// true — a tool that reaches "allow-new" IS approved for the rest of the run, run-scoped grant
// included — but it is no longer the whole persistence decision: for write_file/edit, driveLoop
// prints a SECOND line (printGrantPersisted, above) naming the permanent half, only when a grant
// was actually written. `name` is the same model-supplied call.toolName the approval prompt
// renders, so it gets the same escaping — see escapeControlChars above.
export function toolAllowedLine(name: string): string {
  return `✓ ${escapeControlChars(name)} approved for the rest of this run`;
}

export function printEvent(event: LoopEvent): void {
  switch (event.type) {
    case "text-delta":
      process.stdout.write(event.text);
      break;
    case "tool-call":
      console.log(`\n→ ${event.name}(${JSON.stringify(event.args)})`);
      break;
    case "tool-result":
      console.log(toolResultLine(event));
      break;
    case "permission-denied":
      console.log(`✗ ${event.name} blocked`);
      break;
    case "tool-allowed":
      console.log(toolAllowedLine(event.name));
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
        // Reachable only in approve-each: a read-only block is never a decline (see the
        // permission-denied event's `reason`, and MAX_CONSECUTIVE_DENIALS in loop.ts), so getting
        // here means a live "no" three times in a row. "Answer 'a'" is not always the fix even so —
        // bash and powershell never offer it (the one-rule allowlist: always-allow is scoped to
        // write_file/edit, never a shell), so a streak of shell calls needs /mode instead.
        console.log("Several tool calls were refused in a row, so the run stopped. Run /mode to");
        console.log(
          "switch to auto, or answer 'a' at the next write_file/edit prompt to allow it.",
        );
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

// A run's dollar cost, tagged with its provenance. Kept separate from printUsage's token line
// rather than folded into it: BUILD-PLAN's own verify criterion is that a cost tagged `estimated`
// is VISIBLY distinguishable from one tagged `actual` — a different string on screen, not just
// different data — so `estimated` gets its own "~" prefix and trailing label rather than the same
// template with a swapped-in word.
export function printCost(cost: CostReport): void {
  // `status` is checked before `amountUsd`, not after: `addCost` (cli.ts) can carry a defined
  // dollar figure forward from an earlier, more-certain turn while the combined status degrades to
  // "unknown" (a later turn contributed nothing costable) — printing that number bare would claim
  // more certainty than the total actually has, which is the exact bug VERIFY pass 2 caught.
  if (cost.status === "unknown") {
    console.log(
      cost.amountUsd === undefined
        ? "(cost: unknown)"
        : `(cost: ≥ $${cost.amountUsd.toFixed(4)}, partially unknown)`,
    );
    return;
  }
  if (cost.amountUsd === undefined) {
    console.log("(cost: unknown)");
    return;
  }
  const amount = `$${cost.amountUsd.toFixed(4)}`;
  console.log(cost.status === "estimated" ? `(cost: ~${amount} (estimated))` : `(cost: ${amount})`);
}

// The inline half of printCost's own formatting — needed here because archivistLines renders cost
// on the SAME line as the trigger/token count, not as printCost's own standalone line. Kept
// minimal (amount + estimated-label only) rather than sharing printCost's full branch structure,
// since "unknown" never reaches here: reportFromCatalogPricing (archivist.ts's own caller) always
// returns a defined amountUsd once a catalog entry has pricing, and undefined pricing on the
// archivist's own model is exactly as reachable as it is for the main turn's cost line.
function costFragment(cost: CostReport): string {
  if (cost.amountUsd === undefined) return "cost: unknown";
  const amount = `$${cost.amountUsd.toFixed(4)}`;
  return cost.status === "estimated" ? `cost: ~${amount} (estimated)` : `cost: ${amount}`;
}

// The archivist's usage/cost are reported on their own line, deliberately never summed into
// printUsage/printCost's own totals (driveLoop's own comment on why: folding them in would
// silently change what cli.test.ts's existing "(tokens: …)" assertions mean).
export function archivistLines(
  report: ArchivistReport,
  sink: (line: string) => void = console.log,
): void {
  const tokenParts: string[] = [];
  if (report.usage.inputTokens !== undefined) tokenParts.push(`${report.usage.inputTokens} in`);
  if (report.usage.outputTokens !== undefined) tokenParts.push(`${report.usage.outputTokens} out`);
  const tokens = tokenParts.length > 0 ? `, tokens: ${tokenParts.join(", ")}` : "";
  const cost = report.cost === undefined ? "" : `, ${costFragment(report.cost)}`;
  const calls = `${report.toolCallsMade} tool call${report.toolCallsMade === 1 ? "" : "s"}`;
  sink(`(archivist: ${report.trigger} trigger, ${calls}${tokens}${cost})`);
}
