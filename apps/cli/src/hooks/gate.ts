import { runHook } from "./run";
import { type HookRegistry, hookMatches } from "./types";

export type HookRunner = {
  readonly onBeforeTool: (
    subject: string,
    input: unknown,
  ) => Promise<{ readonly block?: string; readonly errors?: readonly string[] }>;
  readonly onAfterTool: (subject: string, input: unknown) => Promise<readonly string[]>;
};

/**
 * The pair of callbacks runLoop takes, or undefined when this session has no PreToolUse and no
 * PostToolUse hook at all. Undefined from the factory rather than a runner that does nothing, for
 * the reason createRuleInjector returns undefined too: the loop's own opt is then undefined, so a
 * session without hooks gains no callback and no `await` on the path every tool call takes, and the
 * feature costs a project that has not adopted it nothing at all.
 *
 * A cancelled hook rejects out of runHook (it rethrows once the signal has aborted) and that
 * rejection is deliberately not caught here. Catching it would have to invent an outcome the user's
 * Ctrl-C did not produce: "ok" would let the very tool they stopped run anyway, and "failed" would
 * report their own cancel to the model as a broken script.
 */
export function createHookRunner(opts: {
  registry: HookRegistry;
  cwd: string;
  signal?: AbortSignal;
  // Injected so every branch below is reachable from a fake outcome. Without it these cases would
  // each need a real interpreter and a real script on disk, and would re-test the exit-code mapping
  // and the win32/posix pairing that run.ts already owns.
  run?: typeof runHook;
}): HookRunner | undefined {
  const beforeSpecs = opts.registry.get("PreToolUse") ?? [];
  const afterSpecs = opts.registry.get("PostToolUse") ?? [];
  if (beforeSpecs.length === 0 && afterSpecs.length === 0) return undefined;
  const run = opts.run ?? runHook;

  // Sequential rather than Promise.all, in both callbacks. The specs arrive in the order the user
  // wrote them across two scope files; "the first block" is only a fact once the specs ahead of it
  // have finished; and letting two scripts loose on one worktree at the same instant is a
  // formatter-versus-linter race nobody asked for.
  return {
    onBeforeTool: async (subject, input) => {
      const errors: string[] = [];
      for (const spec of beforeSpecs) {
        if (!hookMatches(spec, subject)) continue;
        const outcome = await run(
          spec,
          { event: "PreToolUse", tool: subject, cwd: opts.cwd, input },
          opts.signal,
        );
        // The hooks after a blocker do not run: the call is already refused and their opinions
        // cannot change that. The failures collected before it still travel with the block — a
        // script that could not run is a fact about the project whichever way the call went.
        if (outcome.kind === "block") return { block: outcome.reason, errors };
        if (outcome.kind === "failed") errors.push(outcome.message);
      }
      return { errors };
    },
    onAfterTool: async (subject, input) => {
      const messages: string[] = [];
      for (const spec of afterSpecs) {
        if (!hookMatches(spec, subject)) continue;
        const outcome = await run(
          spec,
          { event: "PostToolUse", tool: subject, cwd: opts.cwd, input },
          opts.signal,
        );
        // Exit 2 has no blocking meaning after the fact: the tool has already run and its result is
        // already on its way to the model, so there is nothing left for a block to stop. Reported
        // as a failure rather than dropped, because dropping it would leave a script its author
        // believes is guarding something doing nothing and saying nothing.
        if (outcome.kind !== "ok") {
          messages.push(outcome.kind === "block" ? outcome.reason : outcome.message);
        }
      }
      return messages;
    },
  };
}
