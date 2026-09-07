import type { ToolExecutionOptions, ToolSet } from "ai";
import { FS_MUTATING_TOOL_NAMES } from "../provider/tools";

export type MutationContext = {
  tool: string;
  toolCallId: string;
  args: unknown;
  rewindTo: number;
};

// Must be synchronous: a Promise would allow an await between snapshot and the write it precedes.
export type OnBeforeMutation = (context: MutationContext) => void;

// Fires only after the mutation has landed; optional and void like OnBeforeMutation.
export type OnAfterMutation = (context: MutationContext) => void;

export function withCheckpoints(
  tools: ToolSet,
  onBeforeMutation: OnBeforeMutation,
  onAfterMutation?: OnAfterMutation,
): ToolSet {
  const mutating = new Set<string>(FS_MUTATING_TOOL_NAMES);

  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;
      if (!mutating.has(name) || execute === undefined) return [name, definition];

      return [
        name,
        {
          ...definition,
          execute: async (
            args: unknown,
            options: ToolExecutionOptions<Record<string, unknown>>,
          ) => {
            const context: MutationContext = {
              tool: name,
              toolCallId: options.toolCallId,
              args,
              rewindTo: options.messages.length - 1,
            };
            onBeforeMutation(context);
            const value = await execute(args, options);
            if (onAfterMutation !== undefined) onAfterMutation(context);
            return value;
          },
        },
      ];
    }),
  ) as ToolSet;
}

export function withMutationRecording(tools: ToolSet, onAfterMutation: OnAfterMutation): ToolSet {
  return withCheckpoints(tools, () => {}, onAfterMutation);
}
