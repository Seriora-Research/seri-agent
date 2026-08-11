import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import type { LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { loadMemoryConfig } from "../config/config";
import {
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  type LoopEvent,
  runLoop,
} from "../loop/loop";
import { type CostReport, reportFromCatalogPricing } from "../provider/cost";
import type { SessionState } from "../session/session";
import { runSubagent, type SubagentRuntime } from "../subagents/dispatch";
import { type LoadedMemory, loadMemory, type MemoryContext, renderMemoryTier } from "./store";
import { makeMemoryWriteTool } from "./tool";

// The archivist's ENTIRE system prompt, not an addendum composed onto a parent's the way
// subagents/roles.ts's four DISPATCHABLE_ROLES are: the archivist has no coding-agent identity to
// inherit — its only job is deciding what belongs in memory and writing it with memory_write, so
// runArchivist passes this directly as runSubagent's `system`, never joinTiers'd with anything
// else. Lives here, not roles.ts: it is memory-specific prose no dispatchable role composes.
export const ARCHIVIST_PROMPT = `You are seri's archivist. You are handed the transcript of a completed stretch of a
coding session and the current contents of the three memory files. Your only job is to decide what
in that transcript is worth remembering, and to record it with memory_write. You have no other
tools: you cannot read files, search, run commands, or edit anything.

Write a fact only if it will still be true and still be useful in a session next week. Corrections
the user made, conventions of this repo, commands that work here, and stated preferences qualify.
Do not record what happened in this session, what you did, or anything the conversation itself
already carries.

Choose the scope by authority, not by topic: a preference is "user" unless it is stated or enforced
as a requirement of one specific repository, in which case it goes in "memory-project" — even when
it is phrased as a preference. When a project requirement contradicts a "user" default, record the
exception in "memory-project"; never edit "user" to carve out a project-specific exception.
Cross-project environment facts go in "memory-global".

Every file has a hard character cap and a write that would exceed it is refused, listing the
current entries. When that happens, consolidate: "replace" two overlapping entries with one, or
"remove" one that a newer fact has invalidated. Never restate a fact already recorded.

Every call also requires "reason" (one short phrase: which turn or fact in the transcript triggered
this write — not a restatement of the entry itself) and "durable" (true if this will still be true
and useful next week, false if you judge it session-scoped but still worth recording provisionally).
A human reviews these alongside your write before it takes effect.`;

// Hermes' own default is ~10 TOOL CALLS, not 10 turns — and turns is the wrong unit here anyway:
// the non-interactive path calls driveLoop exactly once per process, so a turn counter would mean
// `seri "<task>"` never runs the archivist at all. Starting value, to be measured and tuned.
export const ARCHIVIST_TOOL_CALL_INTERVAL = 10;
// The archivist runs when the next turn's input would be within 10% of the compaction threshold,
// so the save outruns the flush.
export const ARCHIVIST_NEAR_COMPACTION_FRACTION = 0.9;

export type ArchivistState = {
  toolCallsSinceRun: number;
  messageCursor: number; // index into `messages` the last pass consumed up to
  messages: ModelMessage[]; // the live transcript, kept current by observeArchivistEvent
  lastInputTokens: number | undefined;
  runs: number;
};

// messageCursor starts at the CURRENT length: a resumed session does not re-archive history a
// previous process already saw or declined to save.
export function createArchivistState(session: SessionState<ModelMessage>): ArchivistState {
  return {
    toolCallsSinceRun: 0,
    messageCursor: session.messages.length,
    messages: session.messages,
    lastInputTokens: undefined,
    runs: 0,
  };
}

// /rewind truncates session.messages directly, between turns (mutatesRunState blocks it while
// one is in flight) — this must be called right at that truncation site, not left to
// maybeRunArchivist's own generic out-of-bounds guard (below), which only runs once per turn, at
// turn END: if enough NEW messages land in the turn right after a rewind to push messages.length
// back past the OLD cursor before that guard next runs, the bounds check `cursor > length` is
// simply false again and never fires — the archivist then silently skips every genuinely-new
// post-rewind message between the rewind point and the stale cursor. cli.ts's own /rewind call
// site (runTui's onSubmit) is the one place that has both archivistState and the post-rewind
// array in scope at the moment of truncation, and calls this directly there.
export function resetArchivistForRewind(state: ArchivistState, messages: ModelMessage[]): void {
  state.messageCursor = 0;
  state.messages = messages;
}

// The archivist's entire view of a turn comes through here — one call per LoopEvent, from
// driveLoop's own for-await body — so this file, not cli.ts, is where its rules live and can be
// read on their own. Only a real "usage" event reflects the actual transcript's input-token
// size: a "compacted" event's own usage is the summarizer's OWN round-trip cost, unrelated to
// post-compaction transcript size, and using it here would pollute the near-compaction trigger's
// math with the wrong number.
export function observeArchivistEvent(state: ArchivistState, event: LoopEvent): void {
  if (event.type === "messages-updated") state.messages = event.messages;
  if (event.type === "tool-call") state.toolCallsSinceRun++;
  if (event.type === "usage")
    state.lastInputTokens = event.usage.inputTokens ?? state.lastInputTokens;
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

// Between two archivist runs, up to ARCHIVIST_TOOL_CALL_INTERVAL tool calls can include large
// outputs (verbose test runs, big file reads) — serialized uncapped, this can trivially exceed
// the archivist's own child model's context window, worst of all on exactly the turn where the
// near-compaction trigger fires (the main session's own context is already largest then). Same
// truncate-with-a-marker shape as loop.ts's MAX_SERIALISED_ERROR_LENGTH and
// tools/spawnCollect.ts's own output cap, not a new one invented here.
const MAX_ARCHIVIST_TRANSCRIPT_CHARS = 40_000;

// The archivist has no read_file, and replace/remove operate by substring against the LIVE file —
// so it must see the three files' current text, not just the transcript, to write correctly.
export function buildArchivistGoal(
  transcript: ModelMessage[],
  memory: LoadedMemory,
  trigger: ArchivistTrigger,
): string {
  const memoryTier = renderMemoryTier(memory);
  const serializedTranscript = JSON.stringify(transcript);
  const truncatedTranscript =
    serializedTranscript.length > MAX_ARCHIVIST_TRANSCRIPT_CHARS
      ? `${serializedTranscript.slice(0, MAX_ARCHIVIST_TRANSCRIPT_CHARS)}… (truncated from ${serializedTranscript.length} characters)`
      : serializedTranscript;
  return (
    `Trigger: ${trigger}.\n\n` +
    `Current memory:\n${memoryTier.length > 0 ? memoryTier : "(all three files are empty)"}\n\n` +
    `Transcript slice to review:\n${truncatedTranscript}`
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
  state: ArchivistState;
  trigger: ArchivistTrigger;
  ctx: MemoryContext;
  model: LanguageModel;
  route: { model: string; provider: ModelProvider };
  catalog: ModelCatalog;
  signal: AbortSignal;
  onWarning: (message: string) => void;
}): Promise<ArchivistReport | undefined> {
  if (args.signal.aborted) return undefined;

  // state.messages, not a separately-passed argument: the two could never legitimately differ
  // (maybeRunArchivist's only production call always passes the same array as state.messages),
  // and a redundant parameter is exactly what let a prior version of this file's own test pass a
  // MISMATCHED pair — reading the transcript off the array a mismatched test can't substitute is
  // what makes the cursor-based slice below an assertion a broken implementation would fail.
  const transcript = args.state.messages.slice(args.state.messageCursor);
  // Reloaded live, not the caller's frozen-per-session PreparedRun.memory: that freeze is correct
  // for the PROMPT tier (buildVolatileTier's own contract — a write now takes effect next
  // session, not this one), but the archivist's own goal needs memory as it actually is right
  // now, especially on a second archivist run in the same session (the approval gate off, or a
  // mid-session /memory approve) — comparing against stale text would miss a duplicate `add` the
  // live file already has.
  const goal = buildArchivistGoal(transcript, loadMemory(args.ctx), args.trigger);
  // The archivist is not dispatched through subagents/roles.ts's buildRoleToolSet: that seam
  // exists for the four DISPATCHABLE_ROLES the model-facing dispatch_subagents tool can name, and
  // the archivist is deliberately unreachable from the model — it never appears in
  // DISPATCHABLE_ROLES, is dispatched directly by this function via runSubagent, and needs
  // exactly one tool, so the ToolSet is simplest built inline.
  const tools: ToolSet = { memory_write: makeMemoryWriteTool(args.ctx) };
  const runtime: SubagentRuntime = {
    runLoop,
    model: args.model,
    provider: args.route.provider,
    modelId: args.route.model,
    catalog: args.catalog,
    // SubagentRuntime.system is required (dispatch.ts's runOne is its only other producer, and
    // that call site genuinely reads it via joinTiers) but runSubagent itself never reads
    // `runtime.system` — only opts.system, passed directly below, which IS what the archivist's
    // child actually runs with. Set here only to satisfy the type; unread for this runtime.
    system: ARCHIVIST_PROMPT,
    permissionMode: () => "auto",
    allowedTools: [],
  };

  let result: Awaited<ReturnType<typeof runSubagent>>;
  try {
    result = await runSubagent({
      tools,
      system: ARCHIVIST_PROMPT,
      messages: [{ role: "user", content: goal }],
      runtime,
      signal: args.signal,
    });
  } catch (err) {
    if (args.signal.aborted) return undefined;
    // A failed attempt still costs one interval, not an infinite per-turn retry: once the counter
    // crosses the threshold, a persistently-failing archivist (bad catalog entry, provider
    // outage, an oversized transcript) would otherwise retry on literally every subsequent turn
    // forever, warning every time, with no backoff and no cap.
    args.state.toolCallsSinceRun = 0;
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

  args.state.messageCursor = args.state.messages.length;
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

// The single entry point driveLoop calls once per turn, right before `finally` unregisters the
// cancel slot — folds the out-of-bounds cursor guard, the live /memory archivist toggle read, and
// the trigger check into one call, so cli.ts carries no archivist-specific branching of its own
// beyond observeArchivistEvent (above) and this.
export async function maybeRunArchivist(args: {
  state: ArchivistState;
  ctx: MemoryContext;
  contextWindow: number | undefined;
  model: LanguageModel;
  route: { model: string; provider: ModelProvider };
  catalog: ModelCatalog;
  signal: AbortSignal;
  onWarning: (message: string) => void;
}): Promise<ArchivistReport | undefined> {
  if (args.signal.aborted) return undefined;
  // A truncation — compaction OR /rewind, both splice `messages` — can leave the cursor pointing
  // past the array's new end. Reset to 0 rather than tracking every possible truncation source
  // individually: this one generic guard covers both without needing per-source notification, and
  // without a deferred set/reset dance across two events (a prior, compaction-only version of
  // this fix needed exactly that dance, unnecessarily — loop.ts splices the array BEFORE
  // yielding the `compacted` event, so nothing ever read a stale cursor against a pre-splice array
  // even before this guard existed; this bounds check is what additionally closes the /rewind
  // gap no compaction-specific fix could, since /rewind was never instrumented at all).
  if (args.state.messageCursor > args.state.messages.length) args.state.messageCursor = 0;

  const enabled = loadMemoryConfig(args.ctx.configDir).archivistEnabled;
  // `?? DEFAULT_CONTEXT_WINDOW_SIZE`, matching runLoop's own fallback exactly (loop.ts) — a model
  // absent from the catalog leaves `contextWindow` undefined, but runLoop's compaction math is
  // already running against this same fallback for that model, so the near-compaction trigger
  // must use the identical number or it silently never fires for exactly that model.
  const trigger = shouldRunArchivist(
    args.state,
    args.contextWindow ?? DEFAULT_CONTEXT_WINDOW_SIZE,
    enabled,
  );
  if (!trigger) return undefined;

  return runArchivist({
    state: args.state,
    trigger,
    ctx: args.ctx,
    model: args.model,
    route: args.route,
    catalog: args.catalog,
    signal: args.signal,
    onWarning: args.onWarning,
  });
}
