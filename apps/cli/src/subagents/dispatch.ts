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
  credential?: RouteCredential;
  temperature?: number;
  seed?: number;
  // A getter, not a resolved value, so a dispatch started after a live /mode change sees the
  // current mode rather than the one driveLoop composed this runtime with.
  permissionMode: () => PermissionMode;
  allowedTools: readonly string[];
  // Same list the parent loop is gated with. Required (empty is fine): a child that omitted
  // this would probe a denied path the parent already refused.
  pathDenials: readonly PathDenial[];
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
    credential?: RouteCredential;
  };
  // Session worktree. Children must not fall back to process.cwd().
  cwd?: string;
  blockReadsOutsideWorkingDirectories?: boolean;
  // The parent's latch, shared by reference. A child has no human to ask, so it can only read
  // the answer the parent already got (or the skip-permissions seed); it never writes the box.
  outsideConsent?: { current: Consent };
  // The parent's hook callbacks, handed down deliberately — and note that this is the opposite of
  // what `createRuleInjector` does, which drive.ts keeps parent-only on purpose. The two are not
  // inconsistent, because a rule and a hook are not the same kind of thing. A rule is CONTEXT: it
  // appends text a model may act on, and a child already inherits every `alwaysApply` rule through
  // the shared system tiers, so withholding the glob-scoped injector costs a child nothing it was
  // promised. A hook is a GUARANTEE — a PreToolUse script that refuses `rm -rf` is a rail, and a
  // rail a child can route around is not a rail, it is a rail with a hole. Without these, every
  // hook in the project is one `dispatch_subagents` call away from being bypassed, and the
  // archivist is the sharpest case of all: it is dispatched with a hardcoded `permissionMode:
  // "auto"` (memory/archivist.ts), so the permission gate is not standing behind the hook there
  // either.
  onBeforeTool?: (
    subject: string,
    input: unknown,
  ) => Promise<{ readonly block?: string; readonly errors?: readonly string[] }>;
  onAfterTool?: (subject: string, input: unknown, result: unknown) => Promise<readonly string[]>;
  containmentEscapeExpected?: boolean;

  // Same inheritance argument as the hooks: a child in auto with no prompt must still see a
  // classifier block, or `dispatch_subagents` is a hole around it. ask becomes a hard deny
  // because this runtime has no approvalPrompt — see fallbackSummary's deny-blocked note.
  classifyToolCall?: ToolCallClassifier;
  autoModeOnBlock?: AutoModeOnBlock;
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

// One generated line per agent, so an agent the model is told about and the ToolSet it actually
// gets are read off the same spec. An agent with no `description` contributes no line at all: the
// model is never told it exists, which is what leaves it reachable only by an explicit /name.
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

// Built per compose (once per turn) rather than at module load, because the registry is
// per-session. Names come from the live map — the same filter dispatchDescription applies — so a
// name the model is never told about is not a name it may pass either. An agent left out here is
// still reachable by an explicit `/name`, which runs dispatchDirect and never consults this schema.
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

// The schema's own enum is built from this same registry, so a name that reaches `execute` should
// always resolve — this narrows the lookup for the type system. `execute` still writes a row for
// the entries this drops, rather than trusting that.
function hasSpec<T>(entry: {
  task: T;
  spec: AgentSpec | undefined;
}): entry is { task: T; spec: AgentSpec } {
  return entry.spec !== undefined;
}

// The pair every result row and every forwarded event carries: what the child actually ran on.
type ChildIdentity = {
  model: string;
  provider: ModelProvider;
  inherited: boolean;
};

// Everything one dispatched child needs, for both engines below: the overlay resolution, the tool
// grant, the addendum, the `child-started` emission and the nested run itself. Shared rather than
// written twice because "a `/name` child is the same child a model-issued dispatch gets" is the
// feature's own promise — two copies of this would be two things to keep equal by hand.
//
// `request` is the TASK's own pair (a model-issued dispatch can name one; `/name` cannot), folded
// over the agent file's by agentRouteRequest. The overlay is resolved once and reused for both the
// event and the row, so a child cannot be announced on one route and reported on another.
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

// `system` (the parent's own composed stable+context+volatile tiers; runOne appends the agent's
// addendum) and `agents` live on this parameter, not SubagentRuntime itself: the archivist reuses
// SubagentRuntime + runSubagent directly (this file's own hand-off comment) but never this
// function, and has neither a parent system prompt to compose nor a registry to be named in.
export function createDispatchTool(
  runtime: SubagentRuntime & { system: string; agents: AgentRegistry },
) {
  const { agents } = runtime;
  return tool({
    description: dispatchDescription(agents),
    inputSchema: dispatchSchema(agents),
    execute: async (args, options) => {
      const { tasks } = args;
      // Names become specs once, here, and nothing below this line takes a name again: the tool
      // grant, the addendum, the checkpoint predicate and the writer serialization all read the
      // spec, so a dynamic agent name physically cannot reach grant logic.
      const scheduled = tasks
        .slice(0, MAX_TASKS_PER_DISPATCH)
        .map((task) => ({ task, spec: agents.get(task.role) }));
      const runnable = scheduled.filter(hasSpec);
      const overflow = tasks.slice(MAX_TASKS_PER_DISPATCH);

      // One parent-anchored snapshot before any child runs, not one per child write: a per-child
      // withCheckpoints would append a child-derived rewindTo to the PARENT session's rewind log
      // (checkpoint.ts's newestDistinct), corrupting /rewind. The anchor is the parent's own
      // message array, which is why this call sits here instead of inside a child. Keyed on the
      // same predicate the serialization below uses (agentMutatesFilesystem), not on a role name:
      // a file-defined agent that grants itself bash still needs the snapshot, or its shell writes
      // have zero /undo coverage.
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

      // Readers (agents holding no mutating tool) run concurrently with each other and with the
      // writer chain below — this is the fan-out the dispatch exists for. Writers (any agent
      // holding a mutating tool) run one at a time, in call order: one filesystem, one writer at a
      // time. This is what makes a child's write through bash/powershell safe by construction, not
      // by tracking which path a call touched — no per-path check could see through an arbitrary
      // shell command anyway. Trade-off, accepted deliberately: two writer tasks writing to
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

      // One row per scheduled task, in call order. A role the registry does not hold gets a
      // not-run row rather than being dropped: the enum and this registry are built from the same
      // Map, so a divergence between them is a bug — and a task that silently vanished is one the
      // model cannot see to re-dispatch.
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
  runtime: SubagentRuntime & { system: string; agents: AgentRegistry },
): ToolSet {
  return { ...tools, [DISPATCH_TOOL_NAME]: createDispatchTool(runtime) };
}

/**
 * The `/name <task>` engine: exactly one child, with the same tool grant, addendum, overlay
 * resolution, checkpoint and child-event forwarding a model-issued dispatch gets — and the message
 * rows loop.ts would have written for it.
 *
 * Three rows, not two. Providers want a user-first, alternating history, and every real dispatch in
 * loop.ts follows a user turn; a synthetic assistant row alone would be the first row of a session
 * whose first action was `/name`. The user row carries the plain task text, never the slash line:
 * the model must not be shown syntax it cannot itself issue, and the tool-call row already says
 * which agent ran.
 *
 * Returned rather than pushed, so the caller appends them as one unit — a throw writes none of
 * them, and history is never left holding a tool call with no result.
 */
export async function dispatchDirect(opts: {
  runtime: SubagentRuntime & { system: string };
  spec: AgentSpec;
  goal: string;
  toolCallId: string;
  /** Where the user row is about to land. Unlike createDispatchTool's own anchor, no row of this
   *  dispatch exists yet, so this is `messages.length` — a later /rewind to it drops the whole
   *  `/name` submission, which is the one user action it undoes. */
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

  // No task pair to fold in: `/name <task>` is a name and free text, with nowhere to say a model.
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
