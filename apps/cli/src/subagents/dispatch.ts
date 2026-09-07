import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import type { JSONValue, LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { joinTiers } from "../agents/systemPrompt";
import type { MutationContext, OnAfterMutation, OnBeforeMutation } from "../checkpoint/wrapTools";
import type { AutoModeOnBlock, ToolCallClassifier } from "../gate/classifier";
import type { Consent } from "../gate/fsBoundary";
import type { PathDenial, PermissionMode } from "../gate/gate";
import type { LoopEvent, runLoop } from "../loop/loop";
import type { CostReport } from "../provider/cost";
import type { RouteCredential } from "../provider/routing";
import { DISPATCH_TOOL_NAME } from "../provider/tools";
import {
  type AgentRegistry,
  type AgentSpec,
  agentMutatesFilesystem,
  agentRouteRequest,
  agentToolSet,
  describeAgent,
} from "./registry";
import type { TaskRouteRequest } from "./routes";



const MAX_TASKS_PER_DISPATCH = 3;


const MAX_CHILD_ITERATIONS = 25;

type DoneReason = Extract<LoopEvent, { type: "done" }>["reason"];

export type SubagentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ChildEventPayload = {
  childId: string;



  role: string;
  goal: string;
  event: LoopEvent | { type: "child-started" };


  model?: string;
  provider?: ModelProvider;
  inherited?: boolean;
};

export type SubagentTask = {
  role: string;
  goal: string;
  model?: string;
  provider?: string;
  effort?: string;
};

export type SubagentResult = SubagentTask & {
  summary: string;
  usage: SubagentUsage;
  toolCallsMade: number;


  doneReason: DoneReason | undefined;


  model?: string;
  provider?: ModelProvider;
  inherited?: boolean;
};

export type DispatchResult = { results: SubagentResult[]; totalUsage: SubagentUsage };



export type SubagentRuntime = {
  runLoop: typeof runLoop;
  model: LanguageModel;
  provider: ModelProvider;
  modelId: string;
  catalog: ModelCatalog;
  contextWindowSize?: number;


  reasoningEffort: string | undefined;
  credential?: RouteCredential;
  temperature?: number;
  seed?: number;


  permissionMode: () => PermissionMode;
  allowedTools: readonly string[];


  pathDenials: readonly PathDenial[];



  checkpointer?: OnBeforeMutation & { onAfterMutation?: OnAfterMutation };
  onChildUsage?: (usage: LanguageModelUsage, cost: CostReport | undefined) => void;

  onChildEvent?: (payload: ChildEventPayload) => void;
  maxIterations?: number;






  resolveRole?: (
    role: string,
    request?: TaskRouteRequest,
  ) => {
    model: LanguageModel;
    provider: ModelProvider;
    modelId: string;
    contextWindowSize?: number;
    reasoningEffort: string | undefined;
    inherited: boolean;
    credential?: RouteCredential;
  };

  cwd?: string;
  blockReadsOutsideWorkingDirectories?: boolean;


  outsideConsent?: { current: Consent };











  onBeforeTool?: (
    subject: string,
    input: unknown,
  ) => Promise<{ readonly block?: string; readonly errors?: readonly string[] }>;
  onAfterTool?: (subject: string, input: unknown, result: unknown) => Promise<readonly string[]>;
  containmentEscapeExpected?: boolean;




  classifyToolCall?: ToolCallClassifier;
  autoModeOnBlock?: AutoModeOnBlock;
};



function addTokens(total: number | undefined, next: number | undefined): number | undefined {
  return next === undefined ? total : (total ?? 0) + next;
}

function sumUsage(a: SubagentUsage, b: SubagentUsage): SubagentUsage {
  return {
    inputTokens: addTokens(a.inputTokens, b.inputTokens),
    outputTokens: addTokens(a.outputTokens, b.outputTokens),
    totalTokens: addTokens(a.totalTokens, b.totalTokens),
  };
}








function fallbackSummary(
  doneReason: DoneReason | undefined,
  lastError: string | undefined,
  deniedCount: number,
  mode: PermissionMode,
  containmentDenied: boolean,
): string {
  if (doneReason === "aborted") return "cancelled before it produced a summary";
  if (deniedCount > 0) {
    if (containmentDenied) {
      return (
        `its tool calls were not permitted (permission mode: "${mode}", ${deniedCount} denied) — ` +
        `auto mode does not lift a containment block`
      );
    }
    return (
      `its tool calls were not permitted (permission mode: "${mode}", ${deniedCount} denied) — ` +
      `it can only write in auto mode or for a tool already granted before this dispatch call`
    );
  }
  if (doneReason === "max-iterations") return "stopped at the iteration cap without a summary";
  return lastError ?? "produced no summary";
}

function shouldForwardChildEvent(event: LoopEvent): boolean {
  switch (event.type) {
    case "tool-call":
    case "tool-result":
    case "text-delta":
    case "permission-denied":
    case "error":
    case "done":
    case "usage":
    case "compacted":
      return true;
    case "messages-updated":
    case "retry":
    case "tool-allowed":
    case "reasoning-delta":
      return false;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}





export async function runSubagent(opts: {
  tools: ToolSet;
  system: string;
  messages: ModelMessage[];
  runtime: SubagentRuntime;
  signal?: AbortSignal;
  child?: {
    id: string;
    role: string;
    goal: string;
    model?: string;
    provider?: ModelProvider;
    inherited?: boolean;
  };
}): Promise<{
  summary: string;






  summaryIsFallback: boolean;
  usage: SubagentUsage;
  toolCallsMade: number;
  doneReason: DoneReason | undefined;
}> {
  const { runtime } = opts;
  const mode = runtime.permissionMode();
  let segment = "";
  let toolCallsMade = 0;
  let usage: SubagentUsage = {};
  let doneReason: DoneReason | undefined;
  let lastError: string | undefined;
  let deniedCount = 0;
  let containmentDenied = false;

  for await (const event of runtime.runLoop({
    model: runtime.model,
    tools: opts.tools,
    messages: opts.messages,
    permissionMode: mode,
    allowedTools: runtime.allowedTools,
    pathDenials: runtime.pathDenials,
    cwd: runtime.cwd,
    system: opts.system,
    signal: opts.signal,
    maxIterations: runtime.maxIterations ?? MAX_CHILD_ITERATIONS,
    provider: runtime.provider,
    modelId: runtime.modelId,
    catalog: runtime.catalog,
    contextWindowSize: runtime.contextWindowSize,
    reasoningEffort: runtime.reasoningEffort,
    credential: runtime.credential,
    temperature: runtime.temperature,
    seed: runtime.seed,
    onBeforeTool: runtime.onBeforeTool,
    onAfterTool: runtime.onAfterTool,
    containmentEscapeExpected: runtime.containmentEscapeExpected,
    classifyToolCall: runtime.classifyToolCall,
    autoModeOnBlock: runtime.autoModeOnBlock,
    workingDirectory: runtime.cwd,
    blockReadsOutsideWorkingDirectories: runtime.blockReadsOutsideWorkingDirectories === true,
    askOutsideFs: false,
    outsideConsent: runtime.outsideConsent,
  })) {
    if (event.type === "text-delta") {
      segment += event.text;
    } else if (event.type === "tool-call") {

      segment = "";
      toolCallsMade++;
    } else if (event.type === "usage" || event.type === "compacted") {



      usage = sumUsage(usage, {
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        totalTokens: event.usage.totalTokens,
      });


      runtime.onChildUsage?.(event.usage, event.type === "usage" ? event.cost : undefined);
    } else if (event.type === "permission-denied") {
      deniedCount++;
      if (event.reason === "containment") containmentDenied = true;
    } else if (event.type === "error") {
      lastError = event.error;
    } else if (event.type === "done") {
      doneReason = event.reason;
    }
    if (opts.child && runtime.onChildEvent && shouldForwardChildEvent(event)) {
      runtime.onChildEvent({
        childId: opts.child.id,
        role: opts.child.role,
        goal: opts.child.goal,
        event,
        model: opts.child.model,
        provider: opts.child.provider,
        inherited: opts.child.inherited,
      });
    }
  }

  const summary = segment.trim();
  const summaryIsFallback = summary.length === 0;
  return {
    summary: summaryIsFallback
      ? fallbackSummary(doneReason, lastError, deniedCount, mode, containmentDenied)
      : summary,
    summaryIsFallback,
    usage,
    toolCallsMade,
    doneReason,
  };
}




export function dispatchDescription(agents: AgentRegistry): string {
  const roster = [...agents.values()]
    .filter((spec) => spec.description.length > 0)
    .map(describeAgent)
    .join(" ");
  return (
    `Run one or more subagents in parallel on separate goals, each with its own limited tool ` +
    `access. Agents — ${roster} Subagents cannot dispatch further subagents — this is a ` +
    `one-level tool. Up to ${MAX_TASKS_PER_DISPATCH} tasks run per call; extra tasks come back as ` +
    `not-run rows so you can re-dispatch them. Each subagent's final assistant message is its ` +
    `only deliverable, returned here as that task's summary. When the user names a model for a ` +
    `child, pass that task's model and provider together: provider is one of groq, openrouter, ` +
    `anthropic, openai, google; model is that provider's id (OpenRouter: the OpenRouter slug). ` +
    `Optional effort is a reasoning tier for that child (for example "high"). A model without a ` +
    `valid provider is ignored. Tasks that omit these fields inherit the session route. A pair ` +
    `that cannot be constructed falls back to the session model.`
  );
}





export function dispatchSchema(agents: AgentRegistry) {
  const names = [...agents.values()]
    .filter((spec) => spec.description.length > 0)
    .map((spec) => spec.name);
  const [first, ...rest] = names;
  if (first === undefined) {
    throw new Error("dispatch schema requires at least one named agent");
  }
  return z.object({
    tasks: z
      .array(
        z.object({
          role: z.enum(names),
          goal: z.string().min(1),
          model: z.string().optional(),
          provider: z.string().optional(),
          effort: z.string().optional(),
        }),
      )
      .min(1),
  });
}




function hasSpec<T>(entry: {
  task: T;
  spec: AgentSpec | undefined;
}): entry is { task: T; spec: AgentSpec } {
  return entry.spec !== undefined;
}


type ChildIdentity = {
  model: string;
  provider: ModelProvider;
  inherited: boolean;
};









async function runAgentChild(opts: {
  runtime: SubagentRuntime & { system: string };
  spec: AgentSpec;
  goal: string;
  childId: string;
  request?: TaskRouteRequest;
  signal?: AbortSignal;
}): Promise<Awaited<ReturnType<typeof runSubagent>> & { identity: ChildIdentity }> {
  const { runtime, spec, goal, childId } = opts;
  const overlay = runtime.resolveRole?.(spec.name, agentRouteRequest(spec, opts.request));
  const identity: ChildIdentity = {
    model: overlay?.modelId ?? runtime.modelId,
    provider: overlay?.provider ?? runtime.provider,
    inherited: overlay?.inherited ?? true,
  };
  runtime.onChildEvent?.({
    childId,
    role: spec.name,
    goal,
    event: { type: "child-started" },
    ...identity,
  });
  const settled = await runSubagent({
    tools: agentToolSet(spec, runtime.checkpointer?.onAfterMutation, runtime.cwd),
    system: joinTiers(runtime.system, spec.addendum),
    messages: [{ role: "user", content: goal }],
    runtime:
      overlay === undefined
        ? runtime
        : {
            ...runtime,
            model: overlay.model,
            provider: overlay.provider,
            modelId: overlay.modelId,
            contextWindowSize: overlay.contextWindowSize,
            reasoningEffort: overlay.reasoningEffort,
            credential: overlay.credential ?? runtime.credential,
          },
    signal: opts.signal,
    child: { id: childId, role: spec.name, goal, ...identity },
  });
  return { ...settled, identity };
}





export function createDispatchTool(
  runtime: SubagentRuntime & { system: string; agents: AgentRegistry },
) {
  const { agents } = runtime;
  return tool({
    description: dispatchDescription(agents),
    inputSchema: dispatchSchema(agents),
    execute: async (args, options) => {
      const { tasks } = args;



      const scheduled = tasks
        .slice(0, MAX_TASKS_PER_DISPATCH)
        .map((task) => ({ task, spec: agents.get(task.role) }));
      const runnable = scheduled.filter(hasSpec);
      const overflow = tasks.slice(MAX_TASKS_PER_DISPATCH);








      if (runnable.some(({ spec }) => agentMutatesFilesystem(spec)) && runtime.checkpointer) {
        const context: MutationContext = {
          tool: DISPATCH_TOOL_NAME,
          toolCallId: options.toolCallId,
          args,
          rewindTo: options.messages.length - 1,
        };
        runtime.checkpointer(context);
      }

      type Runnable = (typeof runnable)[number];

      function runOne(entry: Runnable, index: number) {
        return runAgentChild({
          runtime,
          spec: entry.spec,
          goal: entry.task.goal,
          childId: `${options.toolCallId}:${index}`,
          request: {
            model: entry.task.model,
            provider: entry.task.provider,
            effort: entry.task.effort,
          },
          signal: options.abortSignal,
        });
      }










      const settled: Awaited<ReturnType<typeof runOne>>[] = new Array(runnable.length);
      const readerIdx = runnable
        .map((_, i) => i)
        .filter((i) => !agentMutatesFilesystem(runnable[i].spec));
      const writerIdx = runnable
        .map((_, i) => i)
        .filter((i) => agentMutatesFilesystem(runnable[i].spec));
      await Promise.all([
        ...readerIdx.map(async (i) => {
          settled[i] = await runOne(runnable[i], i);
        }),
        (async () => {
          for (const i of writerIdx) settled[i] = await runOne(runnable[i], i);
        })(),
      ]);





      const results: SubagentResult[] = [];
      let settledIndex = 0;
      for (const { task, spec } of scheduled) {
        if (spec === undefined) {
          results.push({
            role: task.role,
            goal: task.goal,
            summary: `not run: no agent named "${task.role}" is loaded in this session`,
            usage: {},
            toolCallsMade: 0,
            doneReason: undefined,
          });
          continue;
        }
        const child = settled[settledIndex++];
        results.push({
          role: spec.name,
          goal: task.goal,
          summary: child.summary,
          usage: child.usage,
          toolCallsMade: child.toolCallsMade,
          doneReason: child.doneReason,
          ...child.identity,
        });
      }

      for (const task of overflow) {
        results.push({
          role: task.role,
          goal: task.goal,
          summary: `not run: this dispatch already used its ${MAX_TASKS_PER_DISPATCH}-task limit; re-dispatch this task on its own`,



          usage: {},
          toolCallsMade: 0,
          doneReason: undefined,
        });
      }

      const totalUsage = results.reduce<SubagentUsage>((total, r) => sumUsage(total, r.usage), {});

      const result: DispatchResult = { results, totalUsage };
      return result;
    },
  });
}



export function withSubagents(
  tools: ToolSet,
  runtime: SubagentRuntime & { system: string; agents: AgentRegistry },
): ToolSet {
  return { ...tools, [DISPATCH_TOOL_NAME]: createDispatchTool(runtime) };
}


/** `/name <task>` engine: one child with the same grant, overlay, checkpoint, and rows a model dispatch gets. */
export async function dispatchDirect(opts: {
  runtime: SubagentRuntime & { system: string };
  spec: AgentSpec;
  goal: string;
  toolCallId: string;

  rewindTo: number;
  signal?: AbortSignal;
}): Promise<{ result: DispatchResult; rows: readonly ModelMessage[] }> {
  const { runtime, spec, goal, toolCallId } = opts;
  const input = { tasks: [{ role: spec.name, goal }] };

  if (agentMutatesFilesystem(spec) && runtime.checkpointer) {
    runtime.checkpointer({
      tool: DISPATCH_TOOL_NAME,
      toolCallId,
      args: input,
      rewindTo: opts.rewindTo,
    });
  }


  const settled = await runAgentChild({
    runtime,
    spec,
    goal,
    childId: `${toolCallId}:0`,
    signal: opts.signal,
  });

  const result: DispatchResult = {
    results: [
      {
        role: spec.name,
        goal,
        summary: settled.summary,
        usage: settled.usage,
        toolCallsMade: settled.toolCallsMade,
        doneReason: settled.doneReason,
        ...settled.identity,
      },
    ],
    totalUsage: settled.usage,
  };

  return {
    result,
    rows: [
      { role: "user", content: goal },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId, toolName: DISPATCH_TOOL_NAME, input }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: DISPATCH_TOOL_NAME,
            output: { type: "json", value: result as unknown as JSONValue },
          },
        ],
      },
    ],
  };
}
