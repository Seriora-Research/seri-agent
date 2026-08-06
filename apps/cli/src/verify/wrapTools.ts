import type { ToolExecutionOptions, ToolSet } from "ai";
import { runCheck as runCheckReal, type CheckOutcome } from "./run";

// The one tool wrapped, named directly rather than taken from provider/tools.ts's
// FS_MUTATING_TOOL_NAMES. That list is write_file, bash and powershell — the set a checkpoint has
// to be taken in front of, which is a different question from the one here. `bash` and `powershell`
// change the filesystem too, but at no path this wrapper knows, and running the project's check
// after every `bash echo` would charge the check's full cost to commands that wrote nothing.
// Kept separate rather than filtered out of the canonical list, so neither has to bend to the
// other: this is a deliberate single name, not a subset that fell out of an intersection.
const VERIFIED_TOOL = "write_file";

const DISABLED: CheckOutcome = { status: "unavailable", reason: "verification is disabled" };

export type VerifyDeps = {
  // Absent means on. `false` makes the whole feature inert without removing the composition, which
  // is what the per-write cost risk is mitigated with.
  enabled?: boolean;
  // Absent means nothing is ever spawned — the default, and the degradation clause.
  command?: string;
  runCheck?: typeof runCheckReal;
};

// write_file's tool result changes shape. It used to be `void`, which loop.ts:354 turned into
// `{type:"json", value:null}` — nothing in the codebase read it, so there is no consumer to break,
// and `written` is here so the model can still tell a completed write from a failed one now that
// the interesting half of the result is about something else entirely.
export type WriteFileResult = { written: true; verification: CheckOutcome };

// How many diagnostics a tool result is carrying, or undefined if it is not one of ours. It lives
// HERE, beside the code that produces the shape, because loop.ts types a tool result as `unknown`
// (loop.ts:17) so the narrowing has to happen somewhere — and doing it in the printer would make
// output.ts an independent second guess at what this module returns, free to drift from it.
export function writeFileDiagnosticCount(result: unknown): number | undefined {
  const verification = (result as Partial<WriteFileResult> | null | undefined)?.verification;
  return verification?.status === "diagnostics" ? verification.diagnostics.length : undefined;
}

// A pure function over a ToolSet, in the shape checkpoint/wrapTools.ts:29 already established for
// the same situation: runLoop is not touched, loop.ts still knows no tool names (output.ts:75-76),
// and verification stays a consumer policy. The index-alignment invariant at loop.ts:358-363 is
// then satisfied structurally — a wrapper returns one value from one `execute`, so the loop still
// pushes exactly one row per call and there is no way for this design to push a second.
//
// Composed OUTSIDE withCheckpoints at cli.ts, so the snapshot is still taken before the write:
// this wrapper only does anything after `execute` resolves.
export function withVerification(tools: ToolSet, deps: VerifyDeps = {}): ToolSet {
  const runCheck = deps.runCheck ?? runCheckReal;
  const enabled = deps.enabled ?? true;

  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;
      // Every other tool is returned by reference — no wrapper object, so nothing about
      // read_file/edit/grep/glob/bash/powershell changes identity or behaviour.
      if (name !== VERIFIED_TOOL || execute === undefined) return [name, definition];

      return [
        name,
        {
          ...definition,
          execute: async (args: unknown, options: ToolExecutionOptions<Record<string, unknown>>) => {
            // Awaited first, and not caught: a write that threw wrote nothing, so there is
            // nothing to check and the throw is the model's answer.
            await execute(args, options);
            // Advisory, never blocking: the write stands whatever comes back. A multi-file
            // refactor is type-incorrect between its own steps — writing a file that imports a
            // not-yet-written one produces a real error — and blocking would make that
            // impossible to work through. Stage 4's checkpoints are the undo path.
            const verification = enabled ? await runCheck(deps.command, options.abortSignal) : DISABLED;
            return { written: true, verification } satisfies WriteFileResult;
          },
        },
      ];
    }),
  ) as ToolSet;
}
