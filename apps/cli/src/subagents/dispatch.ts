import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import type { JSONValue, LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { joinTiers } from "../agents/systemPrompt";
import {
  type MutationContext,
  type OnAfterMutation,
  type OnBeforeMutation,
  rewindToFromContext,
} from "../checkpoint/wrapTools";
import { messageOf } from "../errors";
import type { AutoModeOnBlock, ToolCallClassifier } from "../gate/classifier";
import type { Consent } from "../gate/fsBoundary";
import type { PathDenial, PermissionMode } from "../gate/gate";
import type { LoopEvent, runLoop } from "../loop/loop";
import type { CostReport } from "../provider/cost";
import type { RouteCredential } from "../provider/routing";
import { DISPATCH_TOOL_NAME } from "../provider/tools";
import type { ToolSpawnEnv } from "../tools/toolSpawnEnv";
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

const CANCELLED_SUMMARY = "cancelled before it produced a summary";
const OVERFLOW_SUMMARY = `not run: this dispatch already used its ${MAX_TASKS_PER_DISPATCH}-task limit; re-dispatch this task on its own`;

type DoneReason = Extract<LoopEvent, { type: "done" }>["reason"];
type FinishedReason = Exclude<DoneReason, "aborted">;

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

export type SubagentId = `${string}:${number}`;

type ChildIdentity = {
  model: string;
  provider: ModelProvider;
  inherited: boolean;
};

type RowBase = {
  id: SubagentId;
  role: string;
  goal: string;
  summary: string;
  usage: SubagentUsage;
  toolCallsMade: number;
};

export type SubagentResult =
  | (RowBase & ChildIdentity & { status: "succeeded"; doneReason: FinishedReason })
  | (RowBase & ChildIdentity & { status: "failed" })
  | (RowBase & ChildIdentity & { status: "cancelled" })
  | (RowBase & { status: "not-run" });

export type SubagentStatus = SubagentResult["status"];

type RanResult = Exclude<SubagentResult, { status: "not-run" }>;

export type DispatchResult = { results: SubagentResult[]; totalUsage: SubagentUsage };

export type DispatchRuntime = SubagentRuntime & { system: string; env: ToolSpawnEnv };

export type SubagentRuntime = {
  runLoop: typeof runLoop;
  model: LanguageModel;
  provider: ModelProvider;
  modelId: string;
  catalog: ModelCatalog;
  contextWindowSize?: number;
  compactionThreshold?: number;
  maxOutputTokens?: number;

  reasoningEffort: string | undefined;
  credential?: RouteCredential;
  temperature?: number;
  seed?: number;

  permissionMode: () => PermissionMode;
  allowedTools: readonly string[];

  pathDenials: readonly PathDenial[];

  checkpointer?: {
    onBeforeMutation: OnBeforeMutation;
    onAfterMutation?: OnAfterMutation;
  };
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
    maxOutputTokens?: number;
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

function subagentId(toolCallId: string, taskIndex: number): SubagentId {
  return `${toolCallId}:${taskIndex}`;
}

function notRunRow(
  id: SubagentId,
  task: { role: string; goal: string },
  summary: string,
): SubagentResult {
  return {
    id,
    status: "not-run",
    role: task.role,
    goal: task.goal,
    summary,
    usage: {},
    toolCallsMade: 0,
  };
}

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
  if (doneReason === "aborted") return CANCELLED_SUMMARY;
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
    case "compaction-held":
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
    compactionThreshold: runtime.compactionThreshold,
    maxOutputTokens: runtime.maxOutputTokens,
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

  const text = segment.trim();
  const terminalError = doneReason === undefined ? lastError : undefined;
  return {
    summary:
      terminalError ??
      (text.length > 0
        ? text
        : fallbackSummary(doneReason, lastError, deniedCount, mode, containmentDenied)),
    summaryIsFallback: terminalError !== undefined || text.length === 0,
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
    `not-run rows so you can re-dispatch them. Every row carries the subagent's id and a status ` +
    `of succeeded, failed, cancelled, or not-run. A failed row's summary is why it failed, and ` +
    `its siblings still report their own results. Each subagent's final assistant message is its ` +
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

type ChildSettlement =
  | ({ kind: "returned" } & Awaited<ReturnType<typeof runSubagent>>)
  | {
      kind: "thrown";
      error: unknown;
      signal: AbortSignal | undefined;
      usage: SubagentUsage;
      toolCallsMade: number;
    };

type StartedOutcome =
  | {
      status: "succeeded";
      doneReason: FinishedReason;
      summary: string;
      usage: SubagentUsage;
      toolCallsMade: number;
    }
  | { status: "failed"; summary: string; usage: SubagentUsage; toolCallsMade: number }
  | { status: "cancelled"; summary: string; usage: SubagentUsage; toolCallsMade: number };

function toStartedOutcome(settlement: ChildSettlement): StartedOutcome {
  if (settlement.kind === "thrown") {
    if (settlement.signal?.aborted) {
      return {
        status: "cancelled",
        summary: CANCELLED_SUMMARY,
        usage: settlement.usage,
        toolCallsMade: settlement.toolCallsMade,
      };
    }
    return {
      status: "failed",
      summary: messageOf(settlement.error),
      usage: settlement.usage,
      toolCallsMade: settlement.toolCallsMade,
    };
  }
  const { summary, usage, toolCallsMade, doneReason } = settlement;
  if (doneReason === "aborted") {
    return { status: "cancelled", summary, usage, toolCallsMade };
  }
  if (doneReason === undefined) {
    return { status: "failed", summary, usage, toolCallsMade };
  }
  return { status: "succeeded", doneReason, summary, usage, toolCallsMade };
}

function startedRow(
  id: SubagentId,
  role: string,
  goal: string,
  identity: ChildIdentity,
  outcome: StartedOutcome,
): RanResult {
  const shared = {
    role,
    goal,
    summary: outcome.summary,
    usage: outcome.usage,
    toolCallsMade: outcome.toolCallsMade,
    model: identity.model,
    provider: identity.provider,
    inherited: identity.inherited,
  };
  if (outcome.status === "succeeded") {
    return { id, status: "succeeded", doneReason: outcome.doneReason, ...shared };
  }
  if (outcome.status === "failed") {
    return { id, status: "failed", ...shared };
  }
  return { id, status: "cancelled", ...shared };
}

async function runAgentChild(opts: {
  runtime: DispatchRuntime;
  spec: AgentSpec;
  goal: string;
  id: SubagentId;
  request?: TaskRouteRequest;
  signal?: AbortSignal;
}): Promise<RanResult> {
  const { runtime, spec, goal, id } = opts;
  const identity: ChildIdentity = {
    model: runtime.modelId,
    provider: runtime.provider,
    inherited: true,
  };
  let spent: { usage: SubagentUsage; toolCallsMade: number } = { usage: {}, toolCallsMade: 0 };
  const emit = (event: ChildEventPayload["event"]) => {
    runtime.onChildEvent?.({ childId: id, role: spec.name, goal, event, ...identity });
  };

  try {
    const overlay = runtime.resolveRole?.(spec.name, agentRouteRequest(spec, opts.request));
    if (overlay !== undefined) {
      identity.model = overlay.modelId;
      identity.provider = overlay.provider;
      identity.inherited = overlay.inherited;
    }
    emit({ type: "child-started" });
    const childRuntime: SubagentRuntime =
      overlay === undefined
        ? runtime
        : {
            ...runtime,
            model: overlay.model,
            provider: overlay.provider,
            modelId: overlay.modelId,
            contextWindowSize: overlay.contextWindowSize,
            maxOutputTokens: overlay.maxOutputTokens,
            reasoningEffort: overlay.reasoningEffort,
            credential: overlay.credential ?? runtime.credential,
          };
    const metered: SubagentRuntime = {
      ...childRuntime,
      onChildUsage: (usage, cost) => {
        spent = {
          usage: sumUsage(spent.usage, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          }),
          toolCallsMade: spent.toolCallsMade,
        };
        childRuntime.onChildUsage?.(usage, cost);
      },
      onChildEvent: (payload) => {
        if (payload.event.type === "tool-call") {
          spent = { usage: spent.usage, toolCallsMade: spent.toolCallsMade + 1 };
        }
        childRuntime.onChildEvent?.(payload);
      },
    };
    const settled = await runSubagent({
      tools: agentToolSet(spec, runtime.env, runtime.checkpointer?.onAfterMutation, runtime.cwd),
      system: joinTiers(runtime.system, spec.addendum),
      messages: [{ role: "user", content: goal }],
      runtime: metered,
      signal: opts.signal,
      child: { id, role: spec.name, goal, ...identity },
    });
    return startedRow(
      id,
      spec.name,
      goal,
      identity,
      toStartedOutcome({ kind: "returned", ...settled }),
    );
  } catch (error) {
    const outcome = toStartedOutcome({
      kind: "thrown",
      error,
      signal: opts.signal,
      usage: spent.usage,
      toolCallsMade: spent.toolCallsMade,
    });
    try {
      if (outcome.status === "failed") emit({ type: "error", error: outcome.summary });
      else emit({ type: "done", reason: "aborted" });
    } catch (emitError) {
      void emitError;
    }
    return startedRow(id, spec.name, goal, identity, outcome);
  }
}

export function createDispatchTool(runtime: DispatchRuntime & { agents: AgentRegistry }) {
  const { agents } = runtime;
  return tool({
    description: dispatchDescription(agents),
    inputSchema: dispatchSchema(agents),
    execute: async (args, options) => {
      const { tasks } = args;
      const specs = tasks.map((task, index) =>
        index < MAX_TASKS_PER_DISPATCH ? agents.get(task.role) : undefined,
      );

      if (
        specs.some((spec) => spec !== undefined && agentMutatesFilesystem(spec)) &&
        runtime.checkpointer
      ) {
        const context: MutationContext = {
          tool: DISPATCH_TOOL_NAME,
          toolCallId: options.toolCallId,
          args,
          rewindTo: rewindToFromContext(options.context),
        };
        runtime.checkpointer.onBeforeMutation(context);
      }

      let writerTail: Promise<unknown> = Promise.resolve();
      const results = await Promise.all(
        tasks.map((task, index): Promise<SubagentResult> => {
          const id = subagentId(options.toolCallId, index);
          if (index >= MAX_TASKS_PER_DISPATCH)
            return Promise.resolve(notRunRow(id, task, OVERFLOW_SUMMARY));
          const spec = specs[index];
          if (spec === undefined) {
            return Promise.resolve(
              notRunRow(
                id,
                task,
                `not run: no agent named "${task.role}" is loaded in this session`,
              ),
            );
          }
          const run = () =>
            runAgentChild({
              runtime,
              spec,
              goal: task.goal,
              id,
              request: {
                model: task.model,
                provider: task.provider,
                effort: task.effort,
              },
              signal: options.abortSignal,
            });
          if (!agentMutatesFilesystem(spec)) return run();
          const row = writerTail.then(() => run());
          writerTail = row;
          return row;
        }),
      );

      const totalUsage = results.reduce<SubagentUsage>(
        (total, row) => sumUsage(total, row.usage),
        {},
      );
      const result: DispatchResult = { results, totalUsage };
      return result;
    },
  });
}

export function withSubagents(
  tools: ToolSet,
  runtime: DispatchRuntime & { agents: AgentRegistry },
): ToolSet {
  return { ...tools, [DISPATCH_TOOL_NAME]: createDispatchTool(runtime) };
}

/** `/name <task>` engine: one child with the same grant, overlay, checkpoint, and rows a model dispatch gets. */
export async function dispatchDirect(opts: {
  runtime: DispatchRuntime;
  spec: AgentSpec;
  goal: string;
  toolCallId: string;

  rewindTo: number;
  signal?: AbortSignal;
}): Promise<{ result: DispatchResult; rows: readonly ModelMessage[] }> {
  const { runtime, spec, goal, toolCallId } = opts;
  const input = { tasks: [{ role: spec.name, goal }] };

  if (agentMutatesFilesystem(spec) && runtime.checkpointer) {
    runtime.checkpointer.onBeforeMutation({
      tool: DISPATCH_TOOL_NAME,
      toolCallId,
      args: input,
      rewindTo: opts.rewindTo,
    });
  }

  const row = await runAgentChild({
    runtime,
    spec,
    goal,
    id: subagentId(toolCallId, 0),
    signal: opts.signal,
  });

  const result: DispatchResult = {
    results: [row],
    totalUsage: row.usage,
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
