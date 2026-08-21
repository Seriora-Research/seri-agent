import type { ToolExecutionOptions, ToolSet } from "ai";
import { FS_MUTATING_TOOL_NAMES } from "../provider/tools";

export type MutationContext = {
  tool: string;
  toolCallId: string;
  args: unknown;
  // The message-array length to truncate to for a conversation rewind. `length - 1`, not `length`:
  // loop.ts:113 pushes the assistant message carrying this tool call immediately before the
  // execute loop and pushes the tool results only at loop.ts:175, so at this instant the last
  // message IS that assistant message. Truncating to `length` would leave a trailing assistant
  // tool-call with no tool result — exactly the AI_MissingToolResultsError that compaction.ts
  // goes out of its way to avoid. That ordering is a coupling to loop.ts, so it is pinned by a
  // test in tests/loop/loop.test.ts rather than defended here.
  rewindTo: number;
};

// Returns void, not Promise<void>, and that is the point. Everything on the checkpoint path is
// synchronous (spawnSync, appendFileSync), so the snapshot is complete before the tool is entered.
// A Promise-returning callback would let a later edit introduce an await point between the
// snapshot and the write it exists to precede — which is the race opencode documented as a real
// bug in their own test suite. The type forbids it.
export type OnBeforeMutation = (context: MutationContext) => void;

// Unlike OnBeforeMutation, running late is exactly the point: this fires only once the mutation
// has actually landed, so a caller building a write ledger from it (checkpoint.ts's own
// recordWrite) never records a path the tool call went on to fail before finishing. Optional and
// void like its counterpart, for the same reason — nothing here needs the result value, and a
// callback that could reject would need its own error policy this file has no opinion on.
export type OnAfterMutation = (context: MutationContext) => void;

// Pure function over a ToolSet: `toolDefinitions` stays a module-level const, `runLoop` is not
// touched, and checkpointing stays a consumer policy rather than a loop concern (AGENTS.md's
// "the loop is a library" invariant does not have to bend). runLoop only calls `execute` after
// the permission gate approves, so a denied tool cannot produce a checkpoint.
export function withCheckpoints(
  tools: ToolSet,
  onBeforeMutation: OnBeforeMutation,
  onAfterMutation?: OnAfterMutation,
): ToolSet {
  const mutating = new Set<string>(FS_MUTATING_TOOL_NAMES);

  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;
      // Non-mutating tools are returned by reference — no wrapper object, so nothing about
      // read_file/edit/grep/glob changes identity or behaviour.
      if (!mutating.has(name) || execute === undefined) return [name, definition];

      return [
        name,
        {
          ...definition,
          execute: (args: unknown, options: ToolExecutionOptions<Record<string, unknown>>) => {
            const context: MutationContext = {
              tool: name,
              toolCallId: options.toolCallId,
              args,
              rewindTo: options.messages.length - 1,
            };
            onBeforeMutation(context);
            const result = execute(args, options);
            if (onAfterMutation === undefined) return result;
            // Every tool.execute in this codebase is built via the AI SDK's `tool()`, whose
            // `execute` is always `async`, so a synchronous throw inside it is already a rejected
            // promise by the time it gets here — `.then` with no second argument passes a
            // rejection straight through unchanged, which is what keeps onAfterMutation from ever
            // running for a call that didn't actually finish.
            return Promise.resolve(result).then((value) => {
              onAfterMutation(context);
              return value;
            });
          },
        },
      ];
    }),
  ) as ToolSet;
}
