import { resolve } from "node:path";
import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  ToolExecutionOptions,
  ToolSet,
} from "ai";
import { tool } from "ai";
import { z } from "zod";
import { joinTiers } from "../agents/systemPrompt";
import { foldsCase } from "../caseFold";
import type { MutationContext, OnBeforeMutation } from "../checkpoint/wrapTools";
import type { PermissionMode } from "../gate/gate";
import type { LoopEvent, runLoop } from "../loop/loop";
import type { CostReport } from "../provider/cost";
import { DISPATCH_TOOL_NAME } from "../provider/tools";
import { buildRoleToolSet, DISPATCHABLE_ROLES, roleAddendum, type SubagentRole } from "./roles";

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

export type SubagentTask = { role: SubagentRole; goal: string };

export type SubagentResult = SubagentTask & {
  summary: string;
  usage: SubagentUsage;
  toolCallsMade: number;
};

export type DispatchResult = { results: SubagentResult[]; totalUsage: SubagentUsage };

// The seam Phase 2's archivist reuses directly (runSubagent + this type), per the plan's own
// hand-off note — stable across both phases.
export type SubagentRuntime = {
  runLoop: typeof runLoop;
  model: LanguageModel;
  provider: ModelProvider;
  modelId: string;
  catalog: ModelCatalog;
  contextWindowSize?: number;
  // The parent's own composed stable+context+volatile tiers; runOne appends the role addendum.
  system: string;
  // A getter, not a resolved value, so a dispatch started after a live /mode change sees the
  // current mode rather than the one driveLoop composed this runtime with.
  permissionMode: () => PermissionMode;
  allowedTools: readonly string[];
  checkpointer?: OnBeforeMutation;
  onChildUsage?: (usage: LanguageModelUsage, cost: CostReport | undefined) => void;
  maxIterations?: number;
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

function fallbackSummary(
  doneReason: DoneReason | undefined,
  lastError: string | undefined,
  mode: PermissionMode,
): string {
  if (doneReason === "aborted") return "cancelled before it produced a summary";
  if (doneReason === "max-iterations") return "stopped at the iteration cap without a summary";
  if (doneReason === "repeated-denials") {
    return (
      `its tool calls were not permitted (permission mode: ${mode}) — a "code" subagent can only ` +
      `write in auto mode or for a tool already granted for this run`
    );
  }
  return lastError ?? "produced no summary";
}

// Drives a child runLoop to completion and derives everything from its events — runLoop's own
// `return`s are bare (loop.ts), so nothing here is a return value. The Phase-2 seam: the archivist
// calls this directly with its own ToolSet and transcript, never through the tool below.
export async function runSubagent(opts: {
  tools: ToolSet;
  system: string;
  messages: ModelMessage[];
  runtime: SubagentRuntime;
  signal?: AbortSignal;
  // Checked after every event; returning true breaks the `for await`, which calls the generator's
  // own `return()` and abandons the child — the only mechanism used to stop one child mid-flight
  // without a second AbortController (dispatch_subagents' writer-overlap serialization uses this).
  stop?: () => boolean;
}): Promise<{
  summary: string;
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
  })) {
    if (event.type === "text-delta") {
      segment += event.text;
    } else if (event.type === "tool-call") {
      // Intermediate narration before a tool call is not the deliverable.
      segment = "";
      toolCallsMade++;
    } else if (event.type === "usage") {
      usage = sumUsage(usage, {
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        totalTokens: event.usage.totalTokens,
      });
      runtime.onChildUsage?.(event.usage, event.cost);
    } else if (event.type === "error") {
      lastError = event.error;
    } else if (event.type === "done") {
      doneReason = event.reason;
    }
    if (opts.stop?.() === true) break;
  }

  const summary = segment.trim();
  return {
    summary: summary.length > 0 ? summary : fallbackSummary(doneReason, lastError, mode),
    usage,
    toolCallsMade,
    doneReason,
  };
}

// Resolved+case-folded per caseFold.ts's own foldsCase, the same normalization
// permissions/store.ts's projectKey uses, so `SRC/a.ts` and `src/a.ts` are one file on
// Windows/macOS and two on Linux.
function pathKey(path: string): string {
  const resolved = resolve(path);
  return foldsCase() ? resolved.toLowerCase() : resolved;
}

// Wraps only write_file (spread-and-replace, checkpoint/wrapTools.ts's own shape) on a `code`
// child's ToolSet with a claim check that runs before the real execute. `edit` writes nothing
// (provider/tools.ts's FS_MUTATING_TOOL_NAMES comment) and a path inside a bash/powershell command
// is unrecoverable without parsing shell — the same knowingly-partial scope verify/wrapTools.ts and
// checkpoint.ts already accept.
function wrapWriteFile(
  tools: ToolSet,
  myIndex: number,
  claims: Map<string, number>,
  running: ReadonlySet<number>,
  conflicts: Map<number, string>,
): ToolSet {
  const definition = tools.write_file;
  if (!definition?.execute) return tools;
  const execute = definition.execute;
  return {
    ...tools,
    write_file: {
      ...definition,
      execute: (args: unknown, options: ToolExecutionOptions<Record<string, unknown>>) => {
        const path = (args as { path: string }).path;
        const key = pathKey(path);
        const owner = claims.get(key);
        // A claim held by a task that has already finished does not block: the file is stable and
        // this write is a legitimate sequential one, not a collision.
        if (owner !== undefined && owner !== myIndex && running.has(owner)) {
          conflicts.set(myIndex, path);
          throw new Error(
            `another subagent is writing ${path} in this same dispatch; this subagent was stopped ` +
              `and will be re-run after it finishes`,
          );
        }
        claims.set(key, myIndex);
        return execute(args, options);
      },
    },
  };
}

const DISPATCH_DESCRIPTION =
  `Run one or more subagents in parallel on separate goals, each with its own limited tool ` +
  `access. Roles — "explore": read-only (read_file, grep, glob), reports findings. "plan": the ` +
  `same read-only tools, reasons toward a change and describes it, never writes it. "code": every ` +
  `tool including write_file/edit/bash/powershell, makes the change. "test": read-only tools plus ` +
  `bash/powershell, runs the project's own checks and reports a verdict, never fixes anything. ` +
  `Subagents cannot dispatch further subagents — this is a one-level tool. Up to ` +
  `${MAX_TASKS_PER_DISPATCH} tasks run per call; extra tasks come back as not-run rows so you can ` +
  `re-dispatch them. Each subagent's final assistant message is its only deliverable, returned ` +
  `here as that task's summary.`;

const inputSchema = z.object({
  tasks: z.array(z.object({ role: z.enum(DISPATCHABLE_ROLES), goal: z.string().min(1) })).min(1),
});

export function createDispatchTool(runtime: SubagentRuntime) {
  return tool({
    description: DISPATCH_DESCRIPTION,
    inputSchema,
    execute: async (args, options) => {
      const { tasks } = args;
      const runnable = tasks.slice(0, MAX_TASKS_PER_DISPATCH);
      const overflow = tasks.slice(MAX_TASKS_PER_DISPATCH);

      // One parent-anchored snapshot before any child runs, not one per child write: a per-child
      // withCheckpoints would append a child-derived rewindTo to the PARENT session's rewind log
      // (checkpoint.ts's newestDistinct), corrupting /rewind. The anchor is the parent's own
      // message array, which is why this call sits here instead of inside a child.
      if (runnable.some((task) => task.role === "code") && runtime.checkpointer) {
        const context: MutationContext = {
          tool: DISPATCH_TOOL_NAME,
          toolCallId: options.toolCallId,
          args,
          rewindTo: options.messages.length - 1,
        };
        runtime.checkpointer(context);
      }

      const claims = new Map<string, number>();
      const running = new Set<number>();
      const conflicts = new Map<number, string>();

      async function runOne(task: SubagentTask, index: number) {
        running.add(index);
        try {
          const roleTools = buildRoleToolSet(task.role);
          const childTools =
            task.role === "code"
              ? wrapWriteFile(roleTools, index, claims, running, conflicts)
              : roleTools;
          return await runSubagent({
            tools: childTools,
            system: joinTiers(runtime.system, roleAddendum(task.role)),
            messages: [{ role: "user", content: task.goal }],
            runtime,
            signal: options.abortSignal,
            stop: () => conflicts.has(index),
          });
        } finally {
          running.delete(index);
        }
      }

      const firstWave = await Promise.all(runnable.map((task, index) => runOne(task, index)));
      const results: SubagentResult[] = runnable.map((task, index) => ({
        role: task.role,
        goal: task.goal,
        summary: firstWave[index].summary,
        usage: firstWave[index].usage,
        toolCallsMade: firstWave[index].toolCallsMade,
      }));

      // Re-run each conflicted task sequentially, one at a time, after the first wave settles.
      // From scratch, not resumed: the loser re-read_files after the winner's write, so its change
      // applies on top instead of clobbering content it read before the winner wrote. Because
      // re-runs are sequential and a finished task's claim never blocks, a re-run cannot conflict
      // again — attempts are summed so the wasted first try still shows up in usage/toolCallsMade.
      // Snapshotted before the loop: a defensive re-conflict during a retry would otherwise
      // re-insert its index into `conflicts` and be picked up by a live iterator, retrying forever.
      const conflictedIndices = [...conflicts.keys()];
      for (const index of conflictedIndices) {
        const task = runnable[index];
        const previous = results[index];
        conflicts.delete(index);
        const attempt = await runOne(task, index);
        results[index] = {
          role: task.role,
          goal: task.goal,
          summary: attempt.summary,
          usage: sumUsage(previous.usage, attempt.usage),
          toolCallsMade: previous.toolCallsMade + attempt.toolCallsMade,
        };
      }

      for (const task of overflow) {
        results.push({
          role: task.role,
          goal: task.goal,
          summary: `not run: this dispatch already used its ${MAX_TASKS_PER_DISPATCH}-task limit; re-dispatch this task on its own`,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          toolCallsMade: 0,
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
export function withSubagents(tools: ToolSet, runtime: SubagentRuntime): ToolSet {
  return { ...tools, [DISPATCH_TOOL_NAME]: createDispatchTool(runtime) };
}
