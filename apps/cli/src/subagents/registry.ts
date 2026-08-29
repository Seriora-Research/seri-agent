import type { ToolName } from "../provider/tools";
import type { TaskRouteRequest } from "./routes";

export type AgentSource = "builtin" | "user" | "project";

/**
 * One dispatchable seat. Produced ONLY by this module — the built-in table below for the five
 * fixed roles, parseAgentFile (agentFile.ts) for a discovered file — which is what makes every
 * field an invariant rather than a hope:
 *   - `toolNames` is keyed out of `toolDefinitions`, so DISPATCH_TOOL_NAME is unrepresentable here
 *     and the one-level recursion guard stays structural (provider/tools.ts's own comment).
 *   - `addendum` is only ever built by composeAddendum, which appends the tool-whitelist sentence,
 *     so an agent whose prompt omits its own tool limits cannot be constructed.
 *   - `request` is complete-or-absent: an agent file naming a model that no configured provider
 *     serves loads with no model/provider at all and a warning, never with a half pin — the same
 *     coupled-pair rule parseRolePins (routes.ts) already states for SERI_ROLE_* env vars.
 */
export type AgentSpec = {
  readonly name: string;
  readonly description: string;
  readonly toolNames: readonly ToolName[];
  readonly addendum: string;
  /** The file's own `model:`/`effort:`, already resolved against the catalog. */
  readonly request: TaskRouteRequest | undefined;
  readonly source: AgentSource;
  readonly filePath: string | undefined;
};

/** Insertion order is precedence order: built-ins, then global, then project. A later `set`
 *  shadows an earlier one, so "project beats global" is structural, not a conditional. */
export type AgentRegistry = ReadonlyMap<string, AgentSpec>;

// The one place the "your only tools this run are: …" sentence is generated, for a built-in and a
// parsed file alike — an agent whose own prompt forgets to state its limits still gets them stated.
// Appended after the parent's own system-prompt tiers (dispatch.ts's runOne), so every subagent
// gets the same tool guidance the parent's "# Tools" section gives plus this correction to it.
export function composeAddendum(opts: {
  name: string;
  job: string;
  toolNames: readonly ToolName[];
}): string {
  const intro =
    opts.job.length === 0
      ? `You are the "${opts.name}" subagent.`
      : `You are a "${opts.name}" subagent: ${opts.job}`;
  return (
    `${intro}\n\nYou cannot dispatch subagents yourself — the "# Tools" list above overstates ` +
    `what you have; your only tools this run are: ${opts.toolNames.join(", ")}. Your final ` +
    `assistant message is your entire deliverable — nothing else you say is returned to whoever ` +
    `dispatched you.`
  );
}
