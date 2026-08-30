import { findCatalogEntry, type ModelCatalog, type ModelProvider } from "@seri/model-catalog";
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
import { makeSkillWriteTool } from "../skills/writeTool";
import { runSubagent, type SubagentRuntime } from "../subagents/dispatch";
import { pendingLabel } from "./pending";
import { type LoadedMemory, loadMemory, type MemoryContext, renderMemoryTier } from "./store";
import { makeMemoryWriteTool } from "./tool";

// The archivist's ENTIRE system prompt, not an addendum composed onto a parent's the way
// subagents/registry.ts's dispatchable agents are: the archivist has no coding-agent identity
// inherit — its only job is deciding what belongs in memory and writing it with memory_write, so
// runArchivist passes this directly as runSubagent's `system`, never joinTiers'd with anything
// else. Lives here, not registry.ts: it is memory-specific prose no dispatchable agent composes.
export const ARCHIVIST_PROMPT = `You are seri's archivist. You are handed the transcript of a completed stretch of a
coding session and the current contents of the three memory files. Your job is to decide what in
that transcript is worth keeping, and to record it — a fact with memory_write, a procedure with
skill_write. Those are your only tools: you cannot read files, search, run commands, or edit
anything.

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

Use skill_write instead when what is worth keeping is a PROCEDURE rather than a fact: a sequence
of steps that was hard to work out and would be worth following again — the order, the checks, the
traps. A fact answers "what is true here"; a skill answers "how do I do this here". Most sessions
warrant neither, and a session that produced one good fact rarely also produced a good skill. Do
not write a skill for something the agent would do correctly anyway, for a one-off task, or for a
sequence you did not actually watch succeed in this transcript. Give it a name someone would guess
and a description that says when to reach for it, because the description is all a future session
sees until it loads the skill.

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
};

// messageCursor starts at the CURRENT length: a resumed session does not re-archive history a
// previous process already saw or declined to save.
export function createArchivistState(
  session: SessionState<ModelMessage>,
  messageCursor = session.messages.length,
): ArchivistState {
  return {
    toolCallsSinceRun: 0,
    messageCursor,
    messages: session.messages,
    lastInputTokens: undefined,
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
  // Deterministic reset at the event itself, not left to maybeRunArchivist's generic end-of-turn
  // bounds check alone (kept anyway, as defense-in-depth for any other future truncation source) —
  // resetArchivistForRewind's own comment explains the exact gap a generic-only check has: enough
  // NEW messages landing in the SAME turn, after this compaction, can push messages.length back
  // past the stale cursor before the end-of-turn guard next runs, at which point `cursor > length`
  // is simply false again and the guard never fires. loop.ts splices the array BEFORE yielding
  // this event, so there is no stale-array window to worry about here the way there was for
  // resetArchivistForRewind's own fix.
  if (event.type === "compacted") state.messageCursor = 0;
}

export type ArchivistTrigger = "tool-count" | "near-compaction" | "idle-timeout";

// `enabled` (the /memory archivist on|off toggle) is checked FIRST and short-circuits before
// either trigger is evaluated — a disabled archivist reports no trigger even when both conditions
// below are independently true. `compactionThreshold` is the same number runLoop's own compaction
// math is actually running against for this turn (opts.compactionThreshold ?? runLoop's own
// DEFAULT_COMPACTION_THRESHOLD, loop.ts) — not the module-level DEFAULT_COMPACTION_THRESHOLD
// constant read directly here, the same class of bug the contextWindowSize fix (below/
// maybeRunArchivist) already closed: using anything but the identical number would silently
// desync the trigger from whatever threshold is actually in effect the moment a caller ever
// passes an override (no caller does today, so this has no observable effect yet).
export function shouldRunArchivist(
  state: ArchivistState,
  contextWindowSize: number | undefined,
  compactionThreshold: number,
  enabled: boolean,
): ArchivistTrigger | undefined {
  if (!enabled) return undefined;
  if (state.toolCallsSinceRun >= ARCHIVIST_TOOL_CALL_INTERVAL) return "tool-count";
  if (
    contextWindowSize !== undefined &&
    state.lastInputTokens !== undefined &&
    state.lastInputTokens / contextWindowSize >=
      compactionThreshold * ARCHIVIST_NEAR_COMPACTION_FRACTION
  ) {
    return "near-compaction";
  }
  return undefined;
}

// Between two archivist runs, up to ARCHIVIST_TOOL_CALL_INTERVAL tool calls can include large
// outputs (verbose test runs, big file reads) — serialized uncapped, this can trivially exceed
// the archivist's own child model's context window, worst of all on exactly the turn where the
// near-compaction trigger fires (the main session's own context is already largest then).
const MAX_ARCHIVIST_TRANSCRIPT_CHARS = 40_000;

// Head-and-tail, not a head-only cut: same SHAPE as tools/spawnCollect.ts's own truncation (its
// own comment: "the useful parts of a long run sit at both ends"), for the same reason here — a
// correction or a fact worth remembering is at least as likely to sit near the END of the window
// as the start, especially for the near-compaction trigger, where the window is largest and the
// content right before it fired is the most recent. A head-only cut silently discarded exactly
// that. Not spawnCollect.ts's own rolling-window machinery: that solves bounding memory while
// output arrives incrementally over many chunks, which does not apply here — buildArchivistGoal
// always receives one complete, already-materialized string, sliced once. Also not its
// surrogate-pair trim at the cut points: that machinery exists there because a live stream is cut
// repeatedly at arbitrary boundaries as more output arrives, so a stray split pair is a real,
// recurring risk across a long run; here the string is sliced exactly once, and a stray split
// pair at one of the two cut points renders as at most one malformed character in a debug-facing
// transcript slice the archivist's own child model must already tolerate arbitrary content in —
// a cosmetic edge case, not a correctness one, so no surrogate-aware trimming was added for it.
function truncateTranscript(serialized: string): string {
  if (serialized.length <= MAX_ARCHIVIST_TRANSCRIPT_CHARS) return serialized;
  const half = MAX_ARCHIVIST_TRANSCRIPT_CHARS / 2;
  const omitted = serialized.length - MAX_ARCHIVIST_TRANSCRIPT_CHARS;
  return `${serialized.slice(0, half)}\n... [${omitted} characters omitted] ...\n${serialized.slice(-half)}`;
}

// The archivist has no read_file, and replace/remove operate by substring against the LIVE file —
// so it must see the three files' current text, not just the transcript, to write correctly.
export function buildArchivistGoal(
  transcript: ModelMessage[],
  memory: LoadedMemory,
  trigger: ArchivistTrigger,
): string {
  const memoryTier = renderMemoryTier(memory);
  const truncatedTranscript = truncateTranscript(JSON.stringify(transcript));
  return (
    `Trigger: ${trigger}.\n\n` +
    `Current memory:\n${memoryTier.length > 0 ? memoryTier : "(all three files are empty)"}\n\n` +
    `Transcript slice to review:\n${truncatedTranscript}`
  );
}

// One entry the archivist put in the review queue this run. `label` is what a human recognises the
// target by: the memory file ("USER.md", "myrepo/MEMORY.md") for a memory write, the skill's own
// name for a skill. `id` is the same 12-hex id `/memory diff` and `/skills diff` resolve, so the
// rendered line is enough to act on without listing the queue first.
export type ArchivistStagedWrite = {
  kind: "memory" | "skill";
  id: string;
  label: string;
};

export type ArchivistReport = {
  trigger: ArchivistTrigger;
  // What this run staged, in call order. Empty when the archivist read the transcript and decided
  // nothing was worth keeping, which is the common case, and also when every write it attempted
  // was refused (the injection scan, a cap overflow) — `toolCallsMade` counts a refused call, so
  // it was never a usable proxy for "something is waiting for you".
  //
  // Only staged writes appear here. With the approval gate off, memory_write applies to the file
  // directly and produces no queue entry to name; skill_write has no such branch and always stages.
  staged: ArchivistStagedWrite[];
  // undefined when the child produced no real closing text of its own — the archivist's own
  // prompt never explicitly asks it to narrate what it did, so runSubagent's own generic
  // fallbackSummary filler ("produced no summary", "stopped at the iteration cap…") is
  // plausibly the common case, and showing that on every archivist line would be noise, not
  // signal. archivistLine (output.ts) only renders a second line when this is defined.
  summary: string | undefined;
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
  contextWindow: number | undefined;
  reasoningEffort?: string;
  signal: AbortSignal;
  onWarning: (message: string) => void;
  forceStage?: boolean;
  // Handed down from the parent's own runner rather than rebuilt here — SubagentRuntime's own
  // comment on this pair argues why a child gets them at all. The archivist needs them more than
  // any dispatched agent does: its runtime below pins `permissionMode: () => "auto"`, so a
  // PreToolUse hook is the only thing left in front of a write it decides to make.
  onBeforeTool?: SubagentRuntime["onBeforeTool"];
  onAfterTool?: SubagentRuntime["onAfterTool"];
  // Overridable only for tests (fakeChildLoop, the same seam subagents/dispatch.test.ts's own
  // makeRuntime already uses) — every production call (maybeRunArchivist, below) leaves this at
  // its default, the real runLoop.
  runLoop?: typeof runLoop;
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
  // The archivist is not dispatched through subagents/registry.ts's agentToolSet: that seam
  // exists for the agents the model-facing dispatch_subagents tool can name, and the archivist is
  // deliberately unreachable from the model — it never appears in the agent registry, is
  // dispatched directly by this function via runSubagent, and needs
  // exactly one tool, so the ToolSet is simplest built inline. The (model, provider) pair on
  // `runtime` is whatever the caller already resolved; this function does not parse role pins.
  const staged: ArchivistStagedWrite[] = [];
  const tools: ToolSet = {
    memory_write: makeMemoryWriteTool(args.ctx, {
      forceStage: args.forceStage === true,
      onStaged: (p) => staged.push({ kind: "memory", id: p.id, label: pendingLabel(p) }),
    }),
    // The second write path, and the only one that produces a whole file. It always stages —
    // there is no approval-off branch the way memory_write has one — because a skill lands inside
    // the user's own tree and steers later sessions.
    skill_write: makeSkillWriteTool(args.ctx, {
      onStaged: (p) => staged.push({ kind: "skill", id: p.id, label: p.name }),
    }),
  };
  const runtime: SubagentRuntime = {
    runLoop: args.runLoop ?? runLoop,
    model: args.model,
    provider: args.route.provider,
    modelId: args.route.model,
    catalog: args.catalog,
    // The same number shouldRunArchivist's own trigger already used (maybeRunArchivist's own
    // `?? DEFAULT_CONTEXT_WINDOW_SIZE` comment) — without this, the child's own runLoop call
    // fell back to runLoop's hardcoded default regardless of the actual model, so its compaction
    // math could be wrong for exactly the model the trigger was tuned against.
    contextWindowSize: args.contextWindow,
    permissionMode: () => "auto",
    allowedTools: [],
    reasoningEffort: args.reasoningEffort,
    onBeforeTool: args.onBeforeTool,
    onAfterTool: args.onAfterTool,
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

  return {
    trigger: args.trigger,
    staged,
    summary: result.summaryIsFallback ? undefined : result.summary,
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
  // Mirrors contextWindow exactly: undefined unless a caller ever overrides runLoop's own
  // compactionThreshold (loop.ts's opts.compactionThreshold — no production caller does today),
  // in which case shouldRunArchivist must see that same override, not its own default.
  compactionThreshold?: number;
  model: LanguageModel;
  route: { model: string; provider: ModelProvider };
  catalog: ModelCatalog;
  signal: AbortSignal;
  onWarning: (message: string) => void;
  reasoningEffort?: string;
  // Passed straight through to runArchivist — see its own comment on this pair.
  onBeforeTool?: SubagentRuntime["onBeforeTool"];
  onAfterTool?: SubagentRuntime["onAfterTool"];
  // Overridable only for tests (fakeChildLoop). Production callers omit it.
  runLoop?: typeof runLoop;
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
    args.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
    enabled,
  );
  if (!trigger) return undefined;

  // Trigger math is the parent transcript vs the parent window (`args.contextWindow`). Nested
  // compaction belongs to the model this pass actually calls, which may differ when the caller
  // routed the archivist onto another pair.
  const childEntry = findCatalogEntry(args.catalog, args.route.model, args.route.provider);
  return runArchivist({
    state: args.state,
    trigger,
    ctx: args.ctx,
    model: args.model,
    route: args.route,
    catalog: args.catalog,
    contextWindow: childEntry?.contextWindow ?? args.contextWindow,
    reasoningEffort: args.reasoningEffort,
    signal: args.signal,
    onWarning: args.onWarning,
    onBeforeTool: args.onBeforeTool,
    onAfterTool: args.onAfterTool,
    runLoop: args.runLoop,
  });
}
