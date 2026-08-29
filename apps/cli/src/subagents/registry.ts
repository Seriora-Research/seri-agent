import type { ToolSet } from "ai";
import { type OnAfterMutation, withMutationRecording } from "../checkpoint/wrapTools";
import {
  createToolDefinitions,
  FS_MUTATING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  type ToolName,
  toolDefinitions,
} from "../provider/tools";
import { pinFromTask, type RoutableRole, type TaskRouteRequest } from "./routes";

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

// `name` is typed against RoutableRole minus the archivist, which is the whole "the archivist is a
// routing target, not a parent-callable agent" rule stated where it cannot be forgotten: adding a
// built-in here that has no SERI_ROLE_<NAME>_* pin, or adding the archivist, is a compile error
// rather than a silently unpinnable agent.
function builtinAgent(opts: {
  name: Exclude<RoutableRole, "archivist">;
  description: string;
  job: string;
  toolNames: readonly ToolName[];
}): AgentSpec {
  return {
    name: opts.name,
    description: opts.description,
    toolNames: opts.toolNames,
    addendum: composeAddendum({ name: opts.name, job: opts.job, toolNames: opts.toolNames }),
    request: undefined,
    source: "builtin",
    filePath: undefined,
  };
}

// `plan` and `oracle` share `explore`'s array by reference: read access is identical among the
// three. Oracle is still a distinct seat — isolated context and a different addendum — not a
// second explorer.
//
// Non-empty by type, which is what lets the dispatch tool's own z.enum be built from registry keys
// without a cast (dispatch.ts destructures this rather than asserting the array is populated).
export const BUILTIN_AGENTS: readonly [AgentSpec, ...AgentSpec[]] = [
  builtinAgent({
    name: "explore",
    description: "Reads the codebase and reports what it finds in text. Never writes.",
    job: "read the codebase and report what you find in text. You cannot write or run commands.",
    toolNames: READ_ONLY_TOOL_NAMES,
  }),
  builtinAgent({
    name: "plan",
    description:
      "Reasons toward a change and describes it in text. Never writes it — that is a separate agent.",
    job: "reason toward a change and describe it in text. You cannot write it — that is a separate role.",
    toolNames: READ_ONLY_TOOL_NAMES,
  }),
  builtinAgent({
    name: "code",
    description: "Makes the change: reads, writes and runs commands.",
    job: "read, write and run commands to make the change.",
    toolNames: Object.keys(toolDefinitions) as ToolName[],
  }),
  builtinAgent({
    name: "test",
    description: "Runs the project's own checks and reports a verdict. Never fixes what fails.",
    job: "run the project's own checks and report a verdict in text. You cannot fix what fails.",
    toolNames: [...READ_ONLY_TOOL_NAMES, "bash", "powershell"],
  }),
  builtinAgent({
    name: "oracle",
    description: "Advises as a senior engineer. Never writes or runs commands.",
    job: "advise as a senior engineer. You cannot write or run commands.",
    toolNames: READ_ONLY_TOOL_NAMES,
  }),
];

export function builtinRegistry(): AgentRegistry {
  return new Map(BUILTIN_AGENTS.map((spec) => [spec.name, spec]));
}

// Definitions passed by reference, never wrapped with the full withCheckpoints — same non-mutating
// idiom as checkpoint/wrapTools.ts's read-only branch. Deliberately NOT withVerification either: a
// `code` child's write_file therefore skips the parent's verify-on-write check, the same way it
// skips withCheckpoints' pre-mutation snapshot (dispatch.ts's own pre-dispatch-snapshot comment
// explains that half). Composing verification into a child's ToolSet is a real design question of
// its own — whether a failure should read like the parent's near-miss report, whether it needs its
// own rewindTo reasoning — left as a follow-up rather than decided here.
//
// `onAfterMutation` IS applied, via withMutationRecording rather than withCheckpoints, when the
// caller has one — this is the write-ledger half only (see wrapTools.ts's own comment on why the
// two halves are separable): a subagent's write_file still needs to be recorded so a later /undo
// can prove it safe to delete, even though nothing about the pre-mutation snapshot applies here.
export function agentToolSet(
  spec: AgentSpec,
  onAfterMutation?: OnAfterMutation,
  cwd = process.cwd(),
): ToolSet {
  const definitions = createToolDefinitions(cwd);
  const tools = Object.fromEntries(
    spec.toolNames.map((name) => [name, definitions[name]]),
  ) as ToolSet;
  return onAfterMutation === undefined ? tools : withMutationRecording(tools, onAfterMutation);
}

// An agent needs the pre-dispatch checkpoint and gets serialized against every other mutating agent
// if it holds ANY tool in FS_MUTATING_TOOL_NAMES — derived from its own grant, not a name list, so
// an agent file that grants itself bash gets both guards without seri knowing it exists.
export function agentMutatesFilesystem(spec: AgentSpec): boolean {
  return spec.toolNames.some((name) =>
    (FS_MUTATING_TOOL_NAMES as readonly string[]).includes(name),
  );
}

// Precedence for one dispatched child: a complete pair on the task wins whole, otherwise the agent
// file's own; effort comes from the task when it named one, else from the file. An incomplete pair
// on either side is dropped rather than half-applied, the same coupled-pair rule pinFromTask states.
export function agentRouteRequest(
  spec: AgentSpec,
  task: TaskRouteRequest | undefined,
): TaskRouteRequest {
  const pin = pinFromTask(task) ?? pinFromTask(spec.request);
  return {
    model: pin?.model,
    provider: pin?.provider,
    effort: task?.effort ?? spec.request?.effort,
  };
}

// One line of the dispatch tool's description. The tool grant is read off `toolNames`, so the prose
// the model sees cannot disagree with the ToolSet the child actually gets.
export function describeAgent(spec: AgentSpec): string {
  return `"${spec.name}": ${spec.description} Tools: ${spec.toolNames.join(", ")}.`;
}
