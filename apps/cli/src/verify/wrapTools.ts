import type { ToolExecutionOptions, ToolSet } from "ai";
import { runCheck as runCheckReal, type CheckOutcome } from "./run";

// ARCHITECTURE.md:140 asks for an escalation after repeated failures. Three, and no retry loop:
// the near-miss report is one enriched error, and the model retries by choosing to issue another
// tool call, which needs no machinery here.
export const MAX_CONSECUTIVE_EDIT_FAILURES = 3;

const ESCALATION = `That is ${MAX_CONSECUTIVE_EDIT_FAILURES} consecutive failed edits. Stop retrying and ask the user which exact text you should be matching.`;

const DISABLED: CheckOutcome = { status: "unavailable", reason: "verification is disabled" };

export type VerifyDeps = {
  // Absent means on. `false` makes the whole feature inert without removing the composition, which
  // is what the per-write cost risk is mitigated with.
  enabled?: boolean;
  runCheck?: typeof runCheckReal;
  timeoutMs?: number;
};

// write_file's tool result changes shape. It used to be `void`, which loop.ts:354 turned into
// `{type:"json", value:null}` — nothing in the codebase read it, so there is no consumer to break,
// and `written` is here so the model can still tell a completed write from a failed one now that
// the interesting half of the result is about something else entirely.
export type WriteFileResult = { written: true; verification: CheckOutcome };

// A pure function over a ToolSet, in the shape checkpoint/wrapTools.ts:29 already established for
// the same situation: runLoop is not touched, loop.ts still knows no tool names (output.ts:74-75),
// and verification stays a consumer policy. The index-alignment invariant at loop.ts:358-363 is
// then satisfied structurally — a wrapper returns one value from one `execute`, so the loop still
// pushes exactly one row per call and there is no way for this design to push a second.
//
// Composed OUTSIDE withCheckpoints at cli.ts, so the snapshot is still taken before the write:
// this wrapper only does anything after `execute` resolves.
export function withVerification(tools: ToolSet, deps: VerifyDeps = {}): ToolSet {
  const runCheck = deps.runCheck ?? runCheckReal;
  const enabled = deps.enabled ?? true;

  // Per session, in this closure. A `--resume` starts a new one and the count silently restarts —
  // accepted: persisting it into the session file is more machinery than a 3-strike hint deserves.
  let consecutiveEditFailures = 0;

  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;
      // Every other tool is returned by reference — no wrapper object, so nothing about
      // read_file/grep/glob/bash/powershell changes identity or behaviour.
      if (execute === undefined || (name !== "write_file" && name !== "edit")) return [name, definition];

      if (name === "write_file") {
        return [
          name,
          {
            ...definition,
            execute: async (args: unknown, options: ToolExecutionOptions<Record<string, unknown>>) => {
              // Awaited first, and not caught: a write that threw wrote nothing, so there is
              // nothing to check and the throw is the model's answer.
              await execute(args, options);
              // Validated against write_file's zod schema (provider/tools.ts:20-24) before execute
              // is reached, so `path` is a string by construction.
              const { path } = args as { path: string };
              // Advisory, never blocking: the write stands whatever comes back. A multi-file
              // refactor is type-incorrect between its own steps — writing a file that imports a
              // not-yet-written one produces a real error — and blocking would make that
              // impossible to work through. Stage 4's checkpoints are the undo path.
              const verification = enabled
                ? await runCheck(path, options.abortSignal, { timeoutMs: deps.timeoutMs })
                : DISABLED;
              return { written: true, verification } satisfies WriteFileResult;
            },
          },
        ];
      }

      return [
        name,
        {
          ...definition,
          execute: async (args: unknown, options: ToolExecutionOptions<Record<string, unknown>>) => {
            try {
              const result = await execute(args, options);
              consecutiveEditFailures = 0;
              return result;
            } catch (err) {
              consecutiveEditFailures++;
              // Below the threshold the original error is re-thrown untouched, stack and all: the
              // near-miss report edit.ts already appended is the useful part, and wrapping it in a
              // new Error every time would cost that stack for no added information.
              if (consecutiveEditFailures < MAX_CONSECUTIVE_EDIT_FAILURES) throw err;
              throw new Error(`${err instanceof Error ? err.message : String(err)}\n${ESCALATION}`);
            }
          },
        },
      ];
    }),
  ) as ToolSet;
}
