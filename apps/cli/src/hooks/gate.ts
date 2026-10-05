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
  const delivered = new Set<string>();
  const takeNotice = (message: string, into: string[]): void => {
    if (delivered.has(message) || into.includes(message)) return;
    into.push(message);
  };
  const remember = (notices: readonly string[]): readonly string[] => {
    for (const notice of notices) delivered.add(notice);
    return notices;
  };

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

        if (outcome.kind === "ok") continue;
        if (outcome.kind === "failed") {
          takeNotice(outcome.message, errors);
          continue;
        }
        if (outcome.kind === "block") return { block: outcome.reason, errors: remember(errors) };
        takeNotice(outcome.message, errors);
        return { block: outcome.message, errors: remember(errors) };
      }
      return { errors: remember(errors) };
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

        if (outcome.kind === "ok") continue;
        takeNotice(outcome.kind === "block" ? outcome.reason : outcome.message, messages);
      }
      return remember(messages);
    },
  };
}
