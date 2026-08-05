import { streamText } from "ai";
import type { AssistantContent, JSONValue, LanguageModel, ModelMessage, ToolContent, ToolSet } from "ai";
import { checkPermission, type PermissionMode } from "../gate/gate";
import { compactMessages, findSafeEvictionBoundary, type CompactionSummary } from "./compaction";

export type LoopEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; name: string; args: unknown }
  | { type: "tool-result"; name: string; result: unknown }
  | { type: "permission-denied"; name: string }
  | { type: "messages-updated"; messages: ModelMessage[] }
  | { type: "compacted"; summary: CompactionSummary; evictedCount: number }
  // "aborted" is a member of the existing termination event rather than a `cancelled` event of its
  // own: the turn IS done, and the reason it is done is that it was aborted. A consumer asking
  // "the generator finished, why?" should not have to handle two shapes to answer it. It is
  // deliberately not an `error` either — a user-initiated cancel is not a failure, and printEvent
  // routes error to stderr, which would put "AbortError" inside whatever consumed the user's pipe.
  | { type: "done"; reason: "no-tool-call" | "max-iterations" | "token-budget" | "aborted" }
  | { type: "error"; error: string };

export type ApprovalPrompt = (toolName: string, args: unknown, signal?: AbortSignal) => Promise<boolean>;

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_TOKEN_BUDGET = 100_000;
// llama-3.3-70b-versatile's (the current default model, src/provider/groq.ts) context
// window; confirmed via console.groq.com/docs/models, 2026-08-02. Fully overridable via
// opts.contextWindowSize.
const DEFAULT_CONTEXT_WINDOW_SIZE = 131_072;
const DEFAULT_COMPACTION_THRESHOLD = 0.5;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 20;

export async function* runLoop(opts: {
  model: LanguageModel;
  tools: ToolSet;
  messages: ModelMessage[];
  permissionMode: PermissionMode;
  approvalPrompt?: ApprovalPrompt;
  maxIterations?: number;
  tokenBudget?: number;
  system?: string;
  contextWindowSize?: number;
  compactionThreshold?: number;
  preserveRecentMessages?: number;
  signal?: AbortSignal;
}): AsyncGenerator<LoopEvent> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const contextWindowSize = opts.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW_SIZE;
  const compactionThreshold = opts.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const preserveRecentMessages = opts.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES;
  const messages: ModelMessage[] = [...opts.messages];

  // The AI SDK auto-runs a tool's `execute` while streaming. Strip it so every
  // tool call is surfaced as an event instead, and runs only after the gate below.
  const schemaOnlyTools = Object.fromEntries(
    Object.entries(opts.tools).map(([name, def]) => {
      const { execute: _execute, ...rest } = def;
      return [name, rest];
    }),
  ) as ToolSet;

  let totalTokens = 0;
  let lastInputTokens = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // What this actually stops, measured rather than assumed: a second streamText setup when the
    // abort landed after a tool phase that completed normally, and a first one when the caller
    // handed in a signal that was already aborted. It is NOT what stops the compaction case, even
    // though that reading is the obvious one — the catch below returns, so control never reaches
    // here again; removing this line leaves that test green. Kept because those two windows are
    // real and nothing else covers them, not because the compaction path needs it.
    if (opts.signal?.aborted) {
      yield { type: "done", reason: "aborted" };
      return;
    }

    if (lastInputTokens / contextWindowSize >= compactionThreshold) {
      const evictBoundary = findSafeEvictionBoundary(messages, preserveRecentMessages);
      if (evictBoundary !== null) {
        try {
          const compacted = await compactMessages(messages, opts.model, evictBoundary, opts.signal);
          messages.splice(0, messages.length, ...compacted.messages);
          totalTokens += compacted.usage.totalTokens ?? 0;
          yield { type: "compacted", summary: compacted.summary, evictedCount: compacted.evictedCount };
          yield { type: "messages-updated", messages: [...messages] };
        } catch (err) {
          // A cancel lands here as an AbortError, and this catch otherwise reports it and falls
          // through into a fresh streamText call in this same iteration — so the top-of-iteration
          // check above cannot be what stops it. Checked here, where the abort actually surfaces.
          if (opts.signal?.aborted) {
            yield { type: "done", reason: "aborted" };
            return;
          }
          yield { type: "error", error: String(err) };
        }
      }
    }

    let text = "";
    const toolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [];

    try {
      const result = streamText({
        model: opts.model,
        tools: schemaOnlyTools,
        messages,
        system: opts.system,
        abortSignal: opts.signal,
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          text += part.text;
          yield { type: "text-delta", text: part.text };
        } else if (part.type === "tool-call") {
          toolCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
        } else if (part.type === "error") {
          yield { type: "error", error: String(part.error) };
          return;
        }
      }
      const resultUsage = await result.usage;
      totalTokens += resultUsage.totalTokens ?? 0;
      lastInputTokens = resultUsage.inputTokens ?? 0;
    } catch (err) {
      // This is the path a mid-stream cancel actually takes, measured against ai@7.0.48: the
      // fullStream yields an `abort` part and closes cleanly — the `for await` above does NOT
      // throw — and it is `await result.usage` that rejects with AbortError. Without this branch a
      // user pressing Ctrl-C would be told on stderr that their turn failed.
      //
      // Returning here is also what discards the partial assistant message: `text` accumulates in
      // a local and only reaches `messages` below, so nothing was pushed and there is nothing to
      // repair. Chosen, not defaulted — a truncated sentence re-fed as the model's own prior turn
      // is worse context than none, and the user cancelled precisely so as not to have it.
      if (opts.signal?.aborted) {
        yield { type: "done", reason: "aborted" };
        return;
      }
      yield { type: "error", error: String(err) };
      return;
    }

    if (toolCalls.length === 0) {
      if (text) {
        messages.push({ role: "assistant", content: [{ type: "text", text }] });
        yield { type: "messages-updated", messages: [...messages] };
      }
      yield { type: "done", reason: "no-tool-call" };
      return;
    }

    const assistantContent: AssistantContent = [];
    if (text) assistantContent.push({ type: "text", text });
    for (const call of toolCalls) {
      assistantContent.push({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
    }
    messages.push({ role: "assistant", content: assistantContent });
    yield { type: "messages-updated", messages: [...messages] };

    const toolResults: ToolContent = [];
    // The index of the call the cancel interrupted, so every call from there on gets a row below.
    // -1 while the turn is still running.
    let cancelledFrom = -1;
    for (const [index, call] of toolCalls.entries()) {
      // Before the call, therefore upstream of the checkpoint snapshot taken inside the wrapper at
      // toolDef.execute — and this is the only point that sees all seven tools, since wrapTools
      // returns the four non-mutating ones by reference. A tool that has not started cannot leave
      // a half-written file behind.
      if (opts.signal?.aborted) {
        cancelledFrom = index;
        break;
      }

      const permission = checkPermission(call.toolName, opts.permissionMode);
      const approved =
        permission === "allow" ||
        (permission === "needs-approval" &&
          opts.approvalPrompt !== undefined &&
          (await opts.approvalPrompt(call.toolName, call.input, opts.signal)));
      // approve-each with no approvalPrompt given, or an explicit denial, is treated as blocked.

      // Re-checked after the prompt, because a cancel that lands while the user is being asked
      // resolves it false (cli.ts closes the readline to unpark the turn) and false is otherwise
      // indistinguishable from a typed "n". Without this the row below would tell the model the
      // call "was not permitted to run" — a denial the user never made — and the model would resume
      // believing its own tool call had been refused rather than interrupted. Only an await can let
      // an abort in, so this is the one place a second check is needed: the guard above already
      // covers the case where the signal was aborted before the call.
      if (opts.signal?.aborted) {
        cancelledFrom = index;
        break;
      }

      if (!approved) {
        yield { type: "permission-denied", name: call.toolName };
        toolResults.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "execution-denied", reason: `Tool "${call.toolName}" was not permitted to run.` },
        });
        continue;
      }

      const toolDef = opts.tools[call.toolName];
      if (!toolDef?.execute) {
        const error = `Unknown tool "${call.toolName}": no matching tool definition.`;
        yield { type: "error", error };
        toolResults.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "error-text", value: error },
        });
        continue;
      }

      yield { type: "tool-call", name: call.toolName, args: call.input };
      let toolResult: unknown;
      try {
        toolResult = await toolDef.execute(call.input, {
          toolCallId: call.toolCallId,
          messages,
          context: {},
          abortSignal: opts.signal,
        });
      } catch (err) {
        // A cancelled tool rejects (spawnCollect and runRipgrep both do), and without this the
        // cancel would be recorded as a tool that failed and the loop would go on to run the next
        // one — which is precisely what the user pressed Ctrl-C to stop.
        if (opts.signal?.aborted) {
          cancelledFrom = index;
          break;
        }
        const error = `Tool "${call.toolName}" threw during execution: ${String(err)}`;
        yield { type: "error", error };
        toolResults.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "error-text", value: error },
        });
        continue;
      }
      yield { type: "tool-result", name: call.toolName, result: toolResult };
      toolResults.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "json", value: (toolResult ?? null) as JSONValue },
      });
    }

    // A cancelled call still gets a row, and so does every call after it. The assistant message
    // carrying the tool calls was already pushed and already persisted by cli.ts, so leaving any
    // of them without a matching tool-result is AI_MissingToolResultsError on the next --resume —
    // the session would be unresumable, which is the one thing a cancel must not do.
    //
    // A row rather than truncating the assistant message away: truncation deletes the model's own
    // text and the record that it decided to run anything, so the resumed conversation looks like
    // the turn never happened and the model's next move is to propose the same call again. Reuses
    // execution-denied, the same output type used for a blocked call above, because it is the same
    // category — this call did not run, and it was the human's doing — and this provider already
    // round-trips it.
    if (cancelledFrom >= 0) {
      for (const call of toolCalls.slice(cancelledFrom)) {
        toolResults.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "execution-denied", reason: `Tool "${call.toolName}" was cancelled by the user before it completed.` },
        });
      }
    }

    messages.push({ role: "tool", content: toolResults });
    yield { type: "messages-updated", messages: [...messages] };

    if (cancelledFrom >= 0) {
      yield { type: "done", reason: "aborted" };
      return;
    }

    if (totalTokens > tokenBudget) {
      yield { type: "done", reason: "token-budget" };
      return;
    }
  }

  yield { type: "done", reason: "max-iterations" };
}
