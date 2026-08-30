import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import type { ToolSet } from "ai";
import { type OnAfterMutation, withMutationRecording } from "../checkpoint/wrapTools";
import { commandByName } from "../cli/commandCatalog";
import { AGENTS_DIRNAME } from "../config/paths";
import { messageOf } from "../errors";
import { type ExtensionSource, extensionScopes } from "../extensions/discovery";
import {
  createToolDefinitions,
  FS_MUTATING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  type ToolName,
  toolDefinitions,
} from "../provider/tools";
import { parseAgentFile } from "./agentFile";
import { isRoutableRole, pinFromTask, type RoutableRole, type TaskRouteRequest } from "./routes";

// "builtin" plus the two scopes every `.seri/<dirname>/` artifact shares (extensions/discovery.ts).
export type AgentSource = "builtin" | ExtensionSource;

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

// Sorted, so two files that both define the same name resolve the same way on every platform and
// every filesystem rather than by readdir order.
function agentFilesIn(dir: string, onWarning: (message: string) => void): readonly string[] {
  try {
    return readdirSync(dir)
      .filter((entry) => entry.toLowerCase().endsWith(".md"))
      .sort()
      .map((entry) => join(dir, entry));
  } catch (err) {
    onWarning(`could not read the agents directory ${dir}: ${messageOf(err)}`);
    return [];
  }
}

/**
 * Built-ins, then the profile root's `agents/`, then the project's `.seri/agents/` — into one Map,
 * in that order, so "project beats global" is a later `set` rather than a conditional. Total: every
 * failure below is a warning, never a throw, because session start must not fail over an agent file.
 */
export function loadAgentRegistry(opts: {
  worktree: string;
  configDir: string;
  catalog: ModelCatalog;
  onWarning: (message: string) => void;
}): AgentRegistry {
  const agents = new Map(builtinRegistry());
  const scopes = extensionScopes({
    worktree: opts.worktree,
    configDir: opts.configDir,
    dirname: AGENTS_DIRNAME,
  });

  // A built-in's name, a routing target's name and a slash command's name are all refused. The
  // routing targets matter beyond tidiness: SERI_ROLE_<NAME>_MODEL is a closed env surface, and a
  // file free to claim one of those names would silently inherit that pin. A name a previously
  // loaded FILE took is NOT reserved — the later `set` wins, which is how a project agent shadows
  // a global one.
  const isReserved = (name: string): boolean =>
    agents.get(name)?.source === "builtin" ||
    isRoutableRole(name) ||
    commandByName(`/${name}`) !== undefined;

  // Which providers hold a key is deliberately not consulted here: the first catalog entry serving
  // the id decides the provider half of the pin, and resolveChildRoute -> resolveRoute (routes.ts)
  // — which knows the configured set AND the plan, including the gateway path — decides how that
  // pair actually routes, rerouting it to a sibling if it has to. Filtering here instead left a
  // hosted-gateway user, who configures no provider at all, unable to pin a model from a file.
  const resolveModel = (id: string): { model: string; provider: ModelProvider } | undefined => {
    const entry = opts.catalog.entries.find((candidate) => candidate.id === id);
    return entry === undefined ? undefined : { model: entry.id, provider: entry.provider };
  };

  for (const scope of scopes) {
    if (!existsSync(scope.dir)) continue;
    const loaded: string[] = [];
    for (const filePath of agentFilesIn(scope.dir, opts.onWarning)) {
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch (err) {
        opts.onWarning(`could not read the agent file ${filePath}: ${messageOf(err)}`);
        continue;
      }
      const outcome = parseAgentFile({
        filePath,
        text,
        source: scope.source,
        isReserved,
        resolveModel,
      });
      if (outcome.kind === "skipped") {
        opts.onWarning(outcome.warning);
        continue;
      }
      for (const warning of outcome.warnings) opts.onWarning(warning);
      // A project agent shadowing a global one is the documented precedence and stays silent. Two
      // files in the SAME directory resolving to one name is an authoring mistake — one definition
      // silently vanishes — and it is the only misload here that would otherwise say nothing.
      const previous = agents.get(outcome.spec.name);
      if (previous?.source === scope.source && previous.filePath !== undefined) {
        opts.onWarning(
          `agent files ${previous.filePath} and ${filePath} both name "${outcome.spec.name}"; the later one wins`,
        );
      }
      agents.set(outcome.spec.name, outcome.spec);
      loaded.push(outcome.spec.name);
    }
    // One line per scope that produced something, so a session says which files it actually took
    // and from where. Until this existed, only a FAILURE was visible: an agent that silently
    // stopped loading (a renamed directory, a profile switch) looked exactly like one still there.
    if (loaded.length > 0) opts.onWarning(`agents from ${scope.dir}: ${loaded.join(", ")}`);
  }
  return agents;
}
