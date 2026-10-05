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

        switch (outcome.kind) {
          case "ok":
            continue;
          case "failed":
            takeNotice(outcome.message, errors);
            continue;
          case "block":
            return { block: outcome.reason, errors: remember(errors) };
          case "unrunnable":
            takeNotice(outcome.message, errors);
            return { block: outcome.message, errors: remember(errors) };
          default: {
            const _never: never = outcome;
            return _never;
          }
        }
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

        switch (outcome.kind) {
          case "ok":
            continue;
          case "failed":
          case "unrunnable":
            takeNotice(outcome.message, messages);
            continue;
          case "block":
            takeNotice(
              outcome.reason.startsWith(`${spec.script} `) || outcome.reason === spec.script
                ? outcome.reason
                : `${spec.script} blocked: ${outcome.reason}`,
              messages,
            );
            continue;
          default: {
            const _never: never = outcome;
            return _never;
          }
        }
      }
      return remember(messages);
    },
  };
}
