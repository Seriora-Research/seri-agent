import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import type { LanguageModel, LanguageModelUsage, ModelMessage } from "ai";
import { DEFAULT_COMPACTION_THRESHOLD, runLoop } from "../loop/loop";
import { type CostReport, reportFromCatalogPricing } from "../provider/cost";
import type { SessionState } from "../session/session";
import { runSubagent, type SubagentRuntime } from "../subagents/dispatch";
import { ARCHIVIST_PROMPT, buildRoleToolSet } from "../subagents/roles";
import { type LoadedMemory, type MemoryContext, renderMemoryTier } from "./store";
import { makeMemoryWriteTool } from "./tool";

// Hermes' own default is ~10 TOOL CALLS, not 10 turns — and turns is the wrong unit here anyway:
// the non-interactive path calls driveLoop exactly once per process, so a turn counter would mean
// `seri "<task>"` never runs the archivist at all. Starting value, to be measured and tuned.
export const ARCHIVIST_TOOL_CALL_INTERVAL = 10;
// The archivist runs when the next turn's input would be within 10% of the compaction threshold,
// so the save outruns the flush.
export const ARCHIVIST_NEAR_COMPACTION_FRACTION = 0.9;

export type ArchivistState = {
  toolCallsSinceRun: number;
  messageCursor: number; // index into session.messages the last pass consumed up to
  lastInputTokens: number | undefined;
  compactedThisTurn: boolean;
  runs: number;
};

// messageCursor starts at the CURRENT length: a resumed session does not re-archive history a
// previous process already saw or declined to save.
export function createArchivistState(session: SessionState<ModelMessage>): ArchivistState {
  return {
    toolCallsSinceRun: 0,
    messageCursor: session.messages.length,
    lastInputTokens: undefined,
    compactedThisTurn: false,
    runs: 0,
  };
}

export type ArchivistTrigger = "tool-count" | "near-compaction";

// `enabled` (the /memory archivist on|off toggle) is checked FIRST and short-circuits before
// either trigger is evaluated — a disabled archivist reports no trigger even when both conditions
// below are independently true.
export function shouldRunArchivist(
  state: ArchivistState,
  contextWindowSize: number | undefined,
  enabled: boolean,
): ArchivistTrigger | undefined {
  if (!enabled) return undefined;
  if (state.toolCallsSinceRun >= ARCHIVIST_TOOL_CALL_INTERVAL) return "tool-count";
  if (
    contextWindowSize !== undefined &&
    state.lastInputTokens !== undefined &&
    state.lastInputTokens / contextWindowSize >=
      DEFAULT_COMPACTION_THRESHOLD * ARCHIVIST_NEAR_COMPACTION_FRACTION
  ) {
    return "near-compaction";
  }
  return undefined;
}

// The archivist has no read_file, and replace/remove operate by substring against the LIVE file —
// so it must see the three files' current text, not just the transcript, to write correctly.
export function buildArchivistGoal(
  transcript: ModelMessage[],
  memory: LoadedMemory,
  trigger: ArchivistTrigger,
): string {
  const memoryTier = renderMemoryTier(memory);
  return (
    `Trigger: ${trigger}.\n\n` +
    `Current memory:\n${memoryTier.length > 0 ? memoryTier : "(all three files are empty)"}\n\n` +
    `Transcript slice to review:\n${JSON.stringify(transcript)}`
  );
}

export type ArchivistReport = {
  trigger: ArchivistTrigger;
  summary: string;
  usage: LanguageModelUsage;
  cost: CostReport | undefined;
  toolCallsMade: number;
};

// Returns undefined and calls onWarning on any failure (dispatch throws, provider error) — an
// archivist run must never fail the user's turn, the same degrade-never-fail policy driveLoop
// already applies to appendBarrier/rememberGrant. An abort is the one exception: it returns
// undefined silently, with no warning.
export async function runArchivist(args: {
  messages: ModelMessage[];
  state: ArchivistState;
  trigger: ArchivistTrigger;
  memory: LoadedMemory;
  ctx: MemoryContext;
  model: LanguageModel;
  route: { model: string; provider: ModelProvider };
  catalog: ModelCatalog;
  signal: AbortSignal;
  onWarning: (message: string) => void;
}): Promise<ArchivistReport | undefined> {
  if (args.signal.aborted) return undefined;

  const transcript = args.messages.slice(args.state.messageCursor);
  const goal = buildArchivistGoal(transcript, args.memory, args.trigger);
  const runtime: SubagentRuntime = {
    runLoop,
    model: args.model,
    provider: args.route.provider,
    modelId: args.route.model,
    catalog: args.catalog,
    system: ARCHIVIST_PROMPT,
    // The archivist never receives an approvalPrompt (same as any dispatch_subagents child, per
    // dispatch.ts's own comment) — "auto" is inert here anyway, since memory_write is not in
    // WRITE_TOOL_NAMES and checkPermission allows it under every mode.
    permissionMode: () => "auto",
    allowedTools: [],
  };

  let result: Awaited<ReturnType<typeof runSubagent>>;
  try {
    result = await runSubagent({
      tools: buildRoleToolSet("archivist", { memory_write: makeMemoryWriteTool(args.ctx) }),
      system: ARCHIVIST_PROMPT,
      messages: [{ role: "user", content: goal }],
      runtime,
      signal: args.signal,
    });
  } catch (err) {
    if (args.signal.aborted) return undefined;
    args.onWarning(`archivist run failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (args.signal.aborted) return undefined;

  const usage: LanguageModelUsage = {
    inputTokens: result.usage.inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: result.usage.outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: result.usage.totalTokens,
  };
  const cost = reportFromCatalogPricing(args.route.model, args.route.provider, usage, args.catalog);

  args.state.messageCursor = args.messages.length;
  args.state.toolCallsSinceRun = 0;
  args.state.runs++;

  return {
    trigger: args.trigger,
    summary: result.summary,
    usage,
    cost,
    toolCallsMade: result.toolCallsMade,
  };
}
