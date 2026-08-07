// The shape a verified `write_file` hands back, and the narrowing that reads it — kept in a module
// with NO runtime dependencies so that the printer can import it.
//
// That constraint is the whole reason this file exists rather than living in wrapTools.ts. Importing
// wrapTools.ts pulls in run.ts, which pulls in spawnCollect.ts, which imports `node:child_process`
// and calls `onSignalCleanup` AT MODULE LOAD — so importing the printer would have registered a
// process-global signal handler as a side effect, and cli/output.ts's header promises the opposite.
// `Diagnostic` comes from parse.ts, which is a regex and a loop and imports nothing.
import type { Diagnostic } from "./parse";

export type CheckOutcome =
  | { status: "ok"; command: string; elapsedMs: number }
  | {
      status: "diagnostics";
      command: string;
      elapsedMs: number;
      // Ordered so that diagnostics in the file just written come FIRST, with `inWrittenFile`
      // counting them. A project-wide check reports a whole repository's debt, and without this
      // split the model cannot tell the error it just caused from eight that were already there —
      // observed in OpenCode as issue #6310, where full-workspace diagnostics made sessions
      // unusable, and #16569 asking for file-level scoping for the same reason.
      diagnostics: Diagnostic[];
      inWrittenFile: number;
      // "This list is known to be incomplete", from either cause: spawnCollect dropped the middle
      // of the output, or the check was killed before it finished. Both mean the same thing to a
      // reader — do not trust the absence of a diagnostic — so they share one flag rather than
      // making the model reason about two.
      truncated: boolean;
      // The number the check actually reported, which is NOT `diagnostics.length` once the cap
      // bites. Every consumer that shows a count to a human has to show this one.
      total: number;
    }
  // No command is configured. The default for every user, and it costs nothing: nothing is spawned.
  | { status: "unavailable"; reason: string }
  // The check itself broke — timeout with no parseable output, spawn error, or an exit code with
  // output this parser could not read. Deliberately never folded into "ok": a checker seri cannot
  // understand must not come back as a green build.
  | { status: "failed"; reason: string };

// write_file's tool result. It used to be `void`, which loop.ts:354 turned into
// `{type:"json", value:null}` — nothing in the codebase read it, so there was no consumer to break,
// and `written` is here so the model can still tell a completed write from a failed one now that
// the interesting half of the result is about something else entirely.
export type WriteFileResult = { written: true; verification: CheckOutcome };

// The narrowing, beside the shape it narrows. loop.ts types a tool result as `unknown`
// (loop.ts:17), so this has to happen somewhere; doing it in the printer would make output.ts an
// independent second guess at what this module returns, free to drift from it. Returns the whole
// outcome rather than one derived number, because how to present it is the printer's business and
// what it IS is this module's.
export function writeFileVerification(result: unknown): CheckOutcome | undefined {
  const verification = (result as Partial<WriteFileResult> | null | undefined)?.verification;
  return typeof verification?.status === "string" ? verification : undefined;
}
