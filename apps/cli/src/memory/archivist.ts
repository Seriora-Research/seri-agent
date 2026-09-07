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
import { type LoadedMemory, loadMemory, type MemoryContext, renderArchivistMemory } from "./store";
import { makeMemoryWriteTool } from "./tool";







export const ARCHIVIST_PROMPT = `You are seri's archivist. You are handed a transcript slice and the current contents of the three memory files. Decide what is worth keeping: a fact with memory_write, a procedure with skill_write. Those are your only tools: you cannot read files, search, run commands, or edit anything. Most passes end with no write, and that is a complete answer. Evaluate memory and skill independently — a good fact is not evidence against a skill.

Write a fact only if it will still be true and still be useful in a session next week. If you would mark durable false, write nothing. Corrections the user made, conventions of this repo, commands that work here, and stated preferences qualify. Do not record what happened in this session, what you did, or anything the conversation itself already carries. If the line needs a past-tense verb about the work ("we", "fixed", "turned out"), it is a diary entry.
  BAD: fixed the flaky test by resetting the cursor
  GOOD: bun test runs the whole suite; bun test <path> runs one file
"content" is one line of plain prose — no newlines, no leading "-", no date; the file stamps its own. Before an "add", look for a line on the same subject in Current memory and "replace" that one instead, with a "target" long enough to match exactly one line.

Choose the scope by authority, not by topic: a preference is "user" unless it is stated or enforced as a requirement of one specific repository, in which case it goes in "memory-project" — even when it is phrased as a preference. When a project requirement contradicts a "user" default, record the exception in "memory-project"; never edit "user" to carve out a project-specific exception. Cross-project environment facts go in "memory-global".

Every file has a hard character cap and a write that would exceed it is refused, listing the current entries. When that happens, consolidate: "replace" two overlapping entries with one, or "remove" one that a newer fact has invalidated. Never restate a fact already recorded.

A fact answers "what is true here"; a skill answers "how do I do this here". Write a skill when all three hold: the transcript shows the steps actually ran and succeeded; something was non-obvious (an order that had to be that way, a check that catches a real failure, a trap the session hit first); and that kind of task recurs here. When they hold, write it, even if you also wrote a fact. Do not write a skill for something the agent would do correctly anyway, for a one-off task, or for a sequence you did not actually watch succeed in this transcript.

Give it a name someone would guess (lowercase, digits, hyphens). "description" is all a future session sees until it loads the skill — one or two sentences: what it does and when to reach for it.
  BAD: Notes about testing in this repository.
  GOOD: Diagnose a test that passes locally and fails on Windows CI. Use when a test is green on one OS and red on another.
"body" is imperative steps for the agent that will follow them — the order, the checks, what to do when one fails. Put "$ARGUMENTS" where the task's subject belongs. No account of this session.

Every call also requires "reason" (one short phrase: which turn or fact in the transcript triggered this write — not a restatement of the entry itself) and "durable" (true). A human reviews these alongside your write before it takes effect. If a write is refused, rephrase plainly and retry in the same turn.

Close with one line: what you wrote, or that nothing was.`;




export const ARCHIVIST_TOOL_CALL_INTERVAL = 10;


export const ARCHIVIST_NEAR_COMPACTION_FRACTION = 0.9;

export type ArchivistState = {
  toolCallsSinceRun: number;
  messageCursor: number;
  messages: ModelMessage[];
  lastInputTokens: number | undefined;
};



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










export function resetArchivistForRewind(state: ArchivistState, messages: ModelMessage[]): void {
  state.messageCursor = 0;
  state.messages = messages;
}







export function observeArchivistEvent(state: ArchivistState, event: LoopEvent): void {
  if (event.type === "messages-updated") state.messages = event.messages;
  if (event.type === "tool-call") state.toolCallsSinceRun++;
  if (event.type === "usage")
    state.lastInputTokens = event.usage.inputTokens ?? state.lastInputTokens;








  if (event.type === "compacted") state.messageCursor = 0;
}

export type ArchivistTrigger = "tool-count" | "near-compaction" | "idle-timeout";










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





const MAX_ARCHIVIST_TRANSCRIPT_CHARS = 40_000;















function truncateTranscript(serialized: string): string {
  if (serialized.length <= MAX_ARCHIVIST_TRANSCRIPT_CHARS) return serialized;
  const half = MAX_ARCHIVIST_TRANSCRIPT_CHARS / 2;
  const omitted = serialized.length - MAX_ARCHIVIST_TRANSCRIPT_CHARS;
  return `${serialized.slice(0, half)}\n... [${omitted} characters omitted] ...\n${serialized.slice(-half)}`;
}



export function buildArchivistGoal(
  transcript: ModelMessage[],
  memory: LoadedMemory,
  trigger: ArchivistTrigger,
): string {
  const memoryTier = renderArchivistMemory(memory);
  const truncatedTranscript = truncateTranscript(JSON.stringify(transcript));
  return (
    `Trigger: ${trigger}.\n\n` +
    `Current memory:\n${memoryTier.length > 0 ? memoryTier : "(all three files are empty)"}\n\n` +
    `Transcript slice to review:\n${truncatedTranscript}`
  );
}





export type ArchivistStagedWrite = {
  kind: "memory" | "skill";
  id: string;
  label: string;
};

export type ArchivistReport = {
  trigger: ArchivistTrigger;







  staged: ArchivistStagedWrite[];





  summary: string | undefined;
  usage: LanguageModelUsage;
  cost: CostReport | undefined;
  toolCallsMade: number;
};





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





  onBeforeTool?: SubagentRuntime["onBeforeTool"];
  onAfterTool?: SubagentRuntime["onAfterTool"];
  containmentEscapeExpected?: boolean;
  classifyToolCall?: SubagentRuntime["classifyToolCall"];
  autoModeOnBlock?: SubagentRuntime["autoModeOnBlock"];



  runLoop?: typeof runLoop;
}): Promise<ArchivistReport | undefined> {
  if (args.signal.aborted) return undefined;






  const transcript = args.state.messages.slice(args.state.messageCursor);






  const goal = buildArchivistGoal(transcript, loadMemory(args.ctx), args.trigger);






  const staged: ArchivistStagedWrite[] = [];
  const tools: ToolSet = {
    memory_write: makeMemoryWriteTool(args.ctx, {
      forceStage: args.forceStage === true,
      onStaged: (p) => staged.push({ kind: "memory", id: p.id, label: pendingLabel(p) }),
    }),



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




    contextWindowSize: args.contextWindow,
    permissionMode: () => "auto",
    allowedTools: [],
    pathDenials: [],
    reasoningEffort: args.reasoningEffort,
    onBeforeTool: args.onBeforeTool,
    onAfterTool: args.onAfterTool,
    containmentEscapeExpected: args.containmentEscapeExpected,
    classifyToolCall: args.classifyToolCall,
    autoModeOnBlock: args.autoModeOnBlock,
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





export async function maybeRunArchivist(args: {
  state: ArchivistState;
  ctx: MemoryContext;
  contextWindow: number | undefined;



  compactionThreshold?: number;
  model: LanguageModel;
  route: { model: string; provider: ModelProvider };
  catalog: ModelCatalog;
  signal: AbortSignal;
  onWarning: (message: string) => void;
  reasoningEffort?: string;

  onBeforeTool?: SubagentRuntime["onBeforeTool"];
  onAfterTool?: SubagentRuntime["onAfterTool"];
  containmentEscapeExpected?: boolean;
  classifyToolCall?: SubagentRuntime["classifyToolCall"];
  autoModeOnBlock?: SubagentRuntime["autoModeOnBlock"];

  runLoop?: typeof runLoop;
}): Promise<ArchivistReport | undefined> {
  if (args.signal.aborted) return undefined;








  if (args.state.messageCursor > args.state.messages.length) args.state.messageCursor = 0;

  const enabled = loadMemoryConfig(args.ctx.configDir).archivistEnabled;




  const trigger = shouldRunArchivist(
    args.state,
    args.contextWindow ?? DEFAULT_CONTEXT_WINDOW_SIZE,
    args.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
    enabled,
  );
  if (!trigger) return undefined;




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
    containmentEscapeExpected: args.containmentEscapeExpected,
    classifyToolCall: args.classifyToolCall,
    autoModeOnBlock: args.autoModeOnBlock,
    runLoop: args.runLoop,
  });
}
