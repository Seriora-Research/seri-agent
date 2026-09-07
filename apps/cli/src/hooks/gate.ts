import { runHook } from "./run";
import { type HookRegistry, hookMatches } from "./types";

export type HookRunner = {
  readonly onBeforeTool: (
    subject: string,
    input: unknown,
  ) => Promise<{ readonly block?: string; readonly errors?: readonly string[] }>;
  readonly onAfterTool: (
    subject: string,
    input: unknown,
    result: unknown,
  ) => Promise<readonly string[]>;
};


export function createHookRunner(opts: {
  registry: HookRegistry;
  cwd: string;
  signal?: AbortSignal;



  run?: typeof runHook;
}): HookRunner | undefined {
  const beforeSpecs = opts.registry.get("PreToolUse") ?? [];
  const afterSpecs = opts.registry.get("PostToolUse") ?? [];
  if (beforeSpecs.length === 0 && afterSpecs.length === 0) return undefined;
  const run = opts.run ?? runHook;





  return {
    onBeforeTool: async (subject, input) => {
      const errors: string[] = [];
      for (const spec of beforeSpecs) {
        if (!hookMatches(spec, subject)) continue;
        const outcome = await run(
          spec,
          { hook_event_name: "PreToolUse", tool_name: subject, cwd: opts.cwd, tool_input: input },
          opts.signal,
        );



        if (outcome.kind === "block") return { block: outcome.reason, errors };
        if (outcome.kind === "failed") errors.push(outcome.message);
      }
      return { errors };
    },
    onAfterTool: async (subject, input, result) => {
      const messages: string[] = [];
      for (const spec of afterSpecs) {
        if (!hookMatches(spec, subject)) continue;
        const outcome = await run(
          spec,
          {
            hook_event_name: "PostToolUse",
            tool_name: subject,
            cwd: opts.cwd,
            tool_input: input,
            tool_response: result,
          },
          opts.signal,
        );




        if (outcome.kind !== "ok") {
          messages.push(outcome.kind === "block" ? outcome.reason : outcome.message);
        }
      }
      return messages;
    },
  };
}
