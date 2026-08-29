import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import type { LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { joinTiers } from "../agents/systemPrompt";
import type { MutationContext, OnAfterMutation, OnBeforeMutation } from "../checkpoint/wrapTools";
import type { PermissionMode } from "../gate/gate";
import type { LoopEvent, runLoop } from "../loop/loop";
import type { CostReport } from "../provider/cost";
import { DISPATCH_TOOL_NAME } from "../provider/tools";
import {
  type AgentRegistry,
  type AgentSpec,
  agentMutatesFilesystem,
  agentRouteRequest,
  agentToolSet,
  BUILTIN_AGENTS,
  builtinRegistry,
  describeAgent,
} from "./registry";
import type { TaskRouteRequest } from "./routes";

// Hermes' own parallel-batch cap (research-spec.md's Sources) — tasks past this per dispatch_subagents
// call are returned as not-run rows instead of being run, so the model can re-dispatch the rest.
const MAX_TASKS_PER_DISPATCH = 3;
// A child must not inherit the parent's (much larger, --max-turns-configurable) iteration cap —
// that is unbounded token multiplication across up to MAX_TASKS_PER_DISPATCH concurrent children.
const MAX_CHILD_ITERATIONS = 25;

type DoneReason = Extract<LoopEvent, { type: "done" }>["reason"];

export type SubagentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ChildEventPayload = {
  childId: string;
  // A label, not a key: the agent name the roster paints and the trajectory records. Nothing
  // downstream of the registry reads it to decide behaviour — tools, addendum, serialization and
  // checkpointing all take an AgentSpec instead, which is why this can widen to any agent name.
  role: string;
  goal: string;
  event: LoopEvent | { type: "child-started" };
  // Present on every forwarded event for a child that actually started. Overflow rows never
  // emit events, so a missing pair here cannot be confused with "not run".
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
  // undefined for a row that never ran (the batch-cap overflow rows below) — output.ts's own
  // renderer uses this to tell "ran" apart from "not run" without a second flag.
  doneReason: DoneReason | undefined;
  // Actual pair the nested runLoop called. Omitted on overflow rows so a not-run task cannot
  // invent a route.
  model?: string;
  provider?: ModelProvider;
  inherited?: boolean;
};

export type DispatchResult = { results: SubagentResult[]; totalUsage: SubagentUsage };

// The seam the archivist reuses directly (runSubagent + this type) — it is a routing target, not
// a dispatchable role, so it never goes through createDispatchTool.
export type SubagentRuntime = {
  runLoop: typeof runLoop;
  model: LanguageModel;
  provider: ModelProvider;
  modelId: string;
  catalog: ModelCatalog;
  contextWindowSize?: number;
  // Same resolved string the parent turn already sent, not a getter: /effort cannot change
  // mid-driveLoop, so a live read would not see a different value than this one.
  reasoningEffort: string | undefined;
  // A getter, not a resolved value, so a dispatch started after a live /mode change sees the
  // current mode rather than the one driveLoop composed this runtime with.
  permissionMode: () => PermissionMode;
  allowedTools: readonly string[];
  // onAfterMutation is optional here even though the concrete Checkpointer (checkpoint.ts) always
  // has one: this type is the generic contract runOne/agentToolSet code against, and a test
  // double or a future caller with no write ledger is still a valid OnBeforeMutation without it.
  checkpointer?: OnBeforeMutation & { onAfterMutation?: OnAfterMutation };
  onChildUsage?: (usage: LanguageModelUsage, cost: CostReport | undefined) => void;
  // TUI live panel; archivist omits child.
  onChildEvent?: (payload: ChildEventPayload) => void;
  maxIterations?: number;
  // Optional overlay: when set, each dispatched child gets this role's model/provider/effort
  // instead of the runtime defaults. The optional request is the task's own pair; omitted,
  // every child shares the runtime (tests, callers that have already resolved the pair onto
  // this object). `role` stays a name rather than an AgentSpec because the archivist — which has
  // no spec, being a routing target and not a dispatchable agent — resolves through the same
  // overlay.
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
  };
  // Session worktree. Children must not fall back to process.cwd().
  cwd?: string;
};

// Sum what showed up, like cli.ts's own addTokens — not imported from there because cli.ts
// composes withSubagents(...) itself, and importing cli.ts back from here would be a module cycle.
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

// doneReason === "repeated-denials" is never checked here: children never receive an
// approvalPrompt (SubagentRuntime has none — the plan's own §5), so decidePermission (loop.ts) can
// only ever return "deny-blocked" for a child, never "deny-declined", and consecutiveDenials only
// counts the latter. deniedCount below is the real, role-agnostic signal — it counts every
// permission-denied event a child got (blocked or declined), not a canned "code"-only string that
// was wrong for a denied "test" subagent, and it fires whether or not the child also hit the
// iteration cap afterward, which is the more informative of the two facts to report.
function fallbackSummary(
  doneReason: DoneReason | undefined,
  lastError: string | undefined,
  deniedCount: number,
  mode: PermissionMode,
): string {
  if (doneReason === "aborted") return "cancelled before it produced a summary";
  if (deniedCount > 0) {
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
      return false;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

// Drives a child runLoop to completion and derives everything from its events — runLoop's own
// `return`s are bare (loop.ts), so nothing here is a return value. The archivist calls this
// directly with its own ToolSet and transcript, never through the tool below.

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
  // True when `summary` is fallbackSummary's own generic filler ("produced no summary", "stopped
  // at the iteration cap…", etc.) rather than the child's own trimmed final segment — dispatch_
  // subagents' own caller (createDispatchTool, below) always wants SOME text to show the parent
  // model regardless of which one it is, but the archivist's own caller (memory/archivist.ts)
  // needs to tell the two apart, so a generic fallback never gets rendered to the user as if it
  // were the model's own explanation.
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

  for await (const event of runtime.runLoop({
    model: runtime.model,
    tools: opts.tools,
    messages: opts.messages,
    permissionMode: mode,
    allowedTools: runtime.allowedTools,
    system: opts.system,
    signal: opts.signal,
    maxIterations: runtime.maxIterations ?? MAX_CHILD_ITERATIONS,
    provider: runtime.provider,
    modelId: runtime.modelId,
    catalog: runtime.catalog,
    contextWindowSize: runtime.contextWindowSize,
    reasoningEffort: runtime.reasoningEffort,
  })) {
    if (event.type === "text-delta") {
      segment += event.text;
    } else if (event.type === "tool-call") {
      // Intermediate narration before a tool call is not the deliverable.
      segment = "";
      toolCallsMade++;
    } else if (event.type === "usage" || event.type === "compacted") {
      // The child's own compaction round-trip is billed like any other call and would otherwise
      // vanish from its usage total — the same asymmetry cli.ts's driveLoop already fixed for the
      // parent (see that file's own "compacted alongside usage" comment).
      usage = sumUsage(usage, {
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        totalTokens: event.usage.totalTokens,
      });
      // compacted has no cost field; the run-level fold still needs the tokens so the TUI live
      // total and printUsage match billed spend.
      runtime.onChildUsage?.(event.usage, event.type === "usage" ? event.cost : undefined);
    } else if (event.type === "permission-denied") {
      deniedCount++;
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
      ? fallbackSummary(doneReason, lastError, deniedCount, mode)
      : summary,
    summaryIsFallback,
    usage,
    toolCallsMade,
    doneReason,
  };
}

// One generated line per agent, so an agent the model is told about and the ToolSet it actually
// gets are read off the same spec. An agent with no `description` contributes no line at all: the
// model is never told it exists, which is what leaves it reachable only by an explicit /name.
function dispatchDescription(agents: AgentRegistry): string {
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

// Destructured rather than asserted: BUILTIN_AGENTS is a non-empty tuple, so the head is an
// AgentSpec by type and z.enum gets the `[string, ...string[]]` it needs with no cast.
function dispatchSchema(agents: AgentRegistry) {
  const [first, ...rest] = BUILTIN_AGENTS;
  const custom = [...agents.keys()].filter((name) => !BUILTIN_AGENTS.some((s) => s.name === name));
  const names: [string, ...string[]] = [first.name, ...rest.map((spec) => spec.name), ...custom];
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

// The schema's own enum is built from this same registry, so a name that reaches `execute` always
// resolves — this narrows the lookup for the type system rather than guarding a reachable case.
function hasSpec<T>(entry: {
  task: T;
  spec: AgentSpec | undefined;
}): entry is { task: T; spec: AgentSpec } {
  return entry.spec !== undefined;
}

// `system` (the parent's own composed stable+context+volatile tiers; runOne appends the role
// addendum) lives on this parameter, not SubagentRuntime itself: the archivist reuses
// SubagentRuntime + runSubagent directly (this file's own hand-off comment) but never this
// function, and its own runtime has no such parent system prompt to compose.
export function createDispatchTool(runtime: SubagentRuntime & { system: string }) {
  const agents = builtinRegistry();
  return tool({
    description: dispatchDescription(agents),
    inputSchema: dispatchSchema(agents),
    execute: async (args, options) => {
      const { tasks } = args;
      // Names become specs once, here, and nothing below this line takes a name again: the tool
      // grant, the addendum, the checkpoint predicate and the writer serialization all read the
      // spec, so a dynamic agent name physically cannot reach grant logic.
      const runnable = tasks
        .slice(0, MAX_TASKS_PER_DISPATCH)
        .map((task) => ({ task, spec: agents.get(task.role) }))
        .filter(hasSpec);
      const overflow = tasks.slice(MAX_TASKS_PER_DISPATCH);

      // One parent-anchored snapshot before any child runs, not one per child write: a per-child
      // withCheckpoints would append a child-derived rewindTo to the PARENT session's rewind log
      // (checkpoint.ts's newestDistinct), corrupting /rewind. The anchor is the parent's own
      // message array, which is why this call sits here instead of inside a child. Keyed on the
      // same predicate the serialization below uses (agentMutatesFilesystem), not on `role ===
      // "code"`: a `test`-only batch holds bash/powershell (both in FS_MUTATING_TOOL_NAMES) and
      // needs the same snapshot, or its shell writes have zero /undo coverage.
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

      function overlayFor(entry: Runnable) {
        return runtime.resolveRole?.(
          entry.spec.name,
          agentRouteRequest(entry.spec, {
            model: entry.task.model,
            provider: entry.task.provider,
            effort: entry.task.effort,
          }),
        );
      }

      function roleIdentity(entry: Runnable): {
        model: string;
        provider: ModelProvider;
        inherited: boolean;
      } {
        const overlay = overlayFor(entry);
        return {
          model: overlay?.modelId ?? runtime.modelId,
          provider: overlay?.provider ?? runtime.provider,
          inherited: overlay?.inherited ?? true,
        };
      }

      function runtimeFor(entry: Runnable): SubagentRuntime {
        const overlay = overlayFor(entry);
        if (overlay === undefined) return runtime;
        return {
          ...runtime,
          model: overlay.model,
          provider: overlay.provider,
          modelId: overlay.modelId,
          contextWindowSize: overlay.contextWindowSize,
          reasoningEffort: overlay.reasoningEffort,
        };
      }

      function runOne(entry: Runnable, index: number) {
        const childId = `${options.toolCallId}:${index}`;
        const identity = roleIdentity(entry);
        runtime.onChildEvent?.({
          childId,
          role: entry.spec.name,
          goal: entry.task.goal,
          event: { type: "child-started" },
          ...identity,
        });
        return runSubagent({
          tools: agentToolSet(entry.spec, runtime.checkpointer?.onAfterMutation, runtime.cwd),
          system: joinTiers(runtime.system, entry.spec.addendum),
          messages: [{ role: "user", content: entry.task.goal }],
          runtime: runtimeFor(entry),
          signal: options.abortSignal,
          child: { id: childId, role: entry.spec.name, goal: entry.task.goal, ...identity },
        });
      }

      // Readers (explore/plan/oracle) run concurrently with each other and with the writer chain
      // below — this is the fan-out the dispatch exists for. Writers (any agent holding a mutating
      // tool: code, test) run one at a time, in call order: one filesystem, one writer at a time.
      // This is what makes a `code` child's write through bash/powershell safe by construction, not
      // by tracking which path a call touched — no per-path check could see through an arbitrary
      // shell command anyway. Trade-off, accepted deliberately: two `code` tasks writing to
      // different paths no longer run concurrently either; the prior per-path mechanism's own
      // remedy for the one case it caught was discarding a full child run, which was already a bad
      // trade.
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

      const results: SubagentResult[] = runnable.map((entry, index) => {
        const identity = roleIdentity(entry);
        return {
          role: entry.spec.name,
          goal: entry.task.goal,
          summary: settled[index].summary,
          usage: settled[index].usage,
          toolCallsMade: settled[index].toolCallsMade,
          doneReason: settled[index].doneReason,
          ...identity,
        };
      });

      for (const task of overflow) {
        results.push({
          role: task.role,
          goal: task.goal,
          summary: `not run: this dispatch already used its ${MAX_TASKS_PER_DISPATCH}-task limit; re-dispatch this task on its own`,
          // {} not zeroed: addTokens' own contract (cli.ts) distinguishes "reported zero" from
          // "never reported", and a row that never ran must stay in the second category or
          // totalUsage on an all-overflow batch would read as a confident zero instead of unknown.
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

// The ToolSet -> ToolSet wrapper idiom of withCheckpoints/withVerification — rolling the feature
// back is deleting the one call site that composes this in (cli.ts's driveLoop).
export function withSubagents(
  tools: ToolSet,
  runtime: SubagentRuntime & { system: string },
): ToolSet {
  return { ...tools, [DISPATCH_TOOL_NAME]: createDispatchTool(runtime) };
}
