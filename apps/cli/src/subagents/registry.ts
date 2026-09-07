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
} from "../provider/tools";
import { parseAgentFile } from "./agentFile";
import { isRoutableRole, pinFromTask, type RoutableRole, type TaskRouteRequest } from "./routes";


export type AgentSource = "builtin" | ExtensionSource;


/** One dispatchable seat: toolNames are keys of toolDefinitions, addendum is composeAddendum, request is complete-or-absent. */
export type AgentSpec = {
  readonly name: string;
  readonly description: string;
  readonly toolNames: readonly ToolName[];
  readonly addendum: string;

  readonly request: TaskRouteRequest | undefined;
  readonly source: AgentSource;
  readonly filePath: string | undefined;
};


/** Insertion order is precedence: built-ins, then global, then project; a later set shadows an earlier one. */
export type AgentRegistry = ReadonlyMap<string, AgentSpec>;





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





function builtinAgent(opts: {
  name: Extract<RoutableRole, "explore" | "plan">;
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






export const BUILTIN_AGENTS: readonly [AgentSpec, ...AgentSpec[]] = [
  builtinAgent({
    name: "explore",
    description: "Reads the codebase and reports what it finds in text. Never writes.",
    job: "read the codebase and report what you find in text. You cannot write or run commands.",
    toolNames: READ_ONLY_TOOL_NAMES,
  }),
  builtinAgent({
    name: "plan",
    description: "Reasons toward a change and describes it in text. Never writes it.",
    job: "reason toward a change and describe it in text. You cannot write it.",
    toolNames: READ_ONLY_TOOL_NAMES,
  }),
];

export function builtinRegistry(): AgentRegistry {
  return new Map(BUILTIN_AGENTS.map((spec) => [spec.name, spec]));
}













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




export function agentMutatesFilesystem(spec: AgentSpec): boolean {
  return spec.toolNames.some((name) =>
    (FS_MUTATING_TOOL_NAMES as readonly string[]).includes(name),
  );
}




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



export function describeAgent(spec: AgentSpec): string {
  return `"${spec.name}": ${spec.description} Tools: ${spec.toolNames.join(", ")}.`;
}



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






  const isReserved = (name: string): boolean =>
    agents.get(name)?.source === "builtin" ||
    isRoutableRole(name) ||
    commandByName(`/${name}`) !== undefined;






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



      const previous = agents.get(outcome.spec.name);
      if (previous?.source === scope.source && previous.filePath !== undefined) {
        opts.onWarning(
          `agent files ${previous.filePath} and ${filePath} both name "${outcome.spec.name}"; the later one wins`,
        );
      }
      agents.set(outcome.spec.name, outcome.spec);
      loaded.push(outcome.spec.name);
    }



    if (loaded.length > 0) opts.onWarning(`agents from ${scope.dir}: ${loaded.join(", ")}`);
  }
  return agents;
}
