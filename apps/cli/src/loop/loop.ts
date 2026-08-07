import { streamText } from "ai";
import type {
  AssistantContent,
  JSONValue,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  ToolContent,
  ToolSet,
} from "ai";
import { checkPermission, WRITE_TOOLS, type PermissionMode } from "../gate/gate";
import { compactMessages, findSafeEvictionBoundary, MAX_RETRIES, type CompactionSummary } from "./compaction";

export type LoopEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; name: string; args: unknown }
  | { type: "tool-result"; name: string; result: unknown }
  | { type: "permission-denied"; name: string }
  | { type: "messages-updated"; messages: ModelMessage[] }
  | { type: "compacted"; summary: CompactionSummary; evictedCount: number; usage: LanguageModelUsage }
  // Per completed model call, not a running total: the loop is stateless by design and summing
  // across turns is the consumer's business. `usage` on `compacted` is the same quantity for the
  // summariser's own round-trip, which is billed like any other and was invisible until now.
  | { type: "usage"; usage: LanguageModelUsage }
  // The SDK's retry, not one of ours — see MAX_RETRIES in compaction.ts. `attempt` counts retries of the current
  // model call, so the first re-issue is 1. There is no error and no delay here because nothing
  // ai@7.0.48 hands out per attempt carries either — streamText's onLanguageModelCallStart for the
  // main call, a middleware's wrapGenerate for compaction's (compaction.ts says why the callback is
  // not usable there). Which of the two was retried is deliberately not a field: the event says the
  // provider is rate-limiting or down and the wait is the SDK's, which is the same fact and the same
  // (absence of an) action for the user either way, and the two cannot interleave — compaction runs
  // to completion before the turn's streamText call starts.
  | { type: "retry"; attempt: number }
  // Emitted the moment an "always" answer lands, before the tool it unblocked runs. The loop keeps
  // its own live Set — that is what the gate reads on the next call — and this event is how the
  // effect leaves the loop, the same way messages, usage and retries do (see the `usage` comment
  // above: the loop is stateless by design and what to do with a per-turn fact is the consumer's
  // business). A consumer that persists the grant and the Set the gate reads are therefore updated
  // from ONE event in ONE direction, which is what stops the live view and the stored view drifting
  // apart the way session.permissionMode and the opts literal in cli.ts can.
  | { type: "tool-allowed"; name: string }
  // "aborted" is a member of the existing termination event rather than a `cancelled` event of its
  // own: the turn IS done, and the reason it is done is that it was aborted. A consumer asking
  // "the generator finished, why?" should not have to handle two shapes to answer it. It is
  // deliberately not an `error` either — a user-initiated cancel is not a failure, and printEvent
  // routes error to stderr, which would put "AbortError" inside whatever consumed the user's pipe.
  | { type: "done"; reason: "no-tool-call" | "max-iterations" | "aborted" | "repeated-denials" }
  | { type: "error"; error: string };

// Three answers, not a boolean, because "yes" and "yes, and stop asking" are different
// instructions and only the caller can act on the second. Deliberately NOT four: there is no
// "cancelled" member. A cancel still arrives as "no" and is still told apart from a typed "n" by
// re-checking opts.signal below — see the comment at the re-check. Adding a member for it would
// create a second, competing way to detect a cancel that the prompt cannot answer honestly
// (cli.ts's onAbort fires for ANY abort, not only a Ctrl-C at this prompt), and would silently
// invalidate the negative control in tests/loop/loop.tools.test.ts that proves a cancel is not
// recorded as a denial.
export type ApprovalAnswer = "once" | "always" | "no";

export type ApprovalPrompt = (toolName: string, args: unknown, signal?: AbortSignal) => Promise<ApprovalAnswer>;

// Hermes' documented default (see docs-tmp research); now reachable from the CLI via
// --max-turns, where it was previously hardcoded and unconfigurable.
const DEFAULT_MAX_ITERATIONS = 500;
// Consecutive denied WRITE-tool calls — reset only by an approved write, never by an approved
// read — after which the run stops instead of continuing to the iteration cap. Reset on a read
// would defeat the whole mechanism: reads are always permitted (checkPermission never blocks
// them), so a model padding its retries with a `glob` or `read_file` between denied writes is
// exactly the pattern this is meant to catch, and resetting on that read would let it keep doing
// so forever. Measured live (tui-ready-permissions step 0, openai/gpt-oss-120b): the exact
// interleaving — denied write, denied write, allowed glob, denied write — that a reset-on-any-
// approval rule would never have stopped. Counted in CALLS, not turns: a turn that emits three
// write calls and has all three refused is the same fact as three refused turns, and counting turns
// would let that turn repeat 500 times. Three rather than one because a single denial is normal
// (the user says no to one thing and the model does something else) and because the model is now
// told the mode and told not to retry, so three is "it was told twice and did it again".
// Not configurable: nothing has asked for it and a flag would be one more thing to get wrong.
const MAX_CONSECUTIVE_DENIALS = 3;
// openai/gpt-oss-120b's (DEFAULT_MODEL in src/provider/groq.ts) context window; confirmed via
// console.groq.com/docs/models, 2026-08-07, when the default moved off llama-3.3-70b-versatile —
// both list 131,072, which is why the switch needed no change here. One number for every model, not
// a per-model lookup: SERI_MODEL can now point at a model with a smaller window and this constant
// will not follow it, so re-check the new model here before changing DEFAULT_MODEL again. What that
// costs a user who points SERI_MODEL at a smaller window — compaction never fires, then every call
// 400s — and why the fix waits for Stage 7a's catalog is written up in docs/PROMPT-ROUTING.md.
// Fully overridable via opts.contextWindowSize.
const DEFAULT_CONTEXT_WINDOW_SIZE = 131_072;
const DEFAULT_COMPACTION_THRESHOLD = 0.5;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 20;

const MAX_SERIALISED_ERROR_LENGTH = 500;

// String() of an Error is `${name}: ${message}` — one line, and exactly what the four sites below
// already produced, so nothing changes for an Error. What changes is the other branch: a provider
// that hands over a plain object (Groq rejects with {"error":{"message":…,"type":…}}) stringified
// to the literal "[object Object]", which names neither the failure nor its origin. JSON.stringify
// rather than plucking `.message`: the payload shape is the provider's, not ours, and guessing at
// one field is how the next provider gets "[object Object]" back.
//
// The try is not padding: JSON.stringify throws on a cyclic value, and the site that renders a
// thrown tool failure (below, in the template literal) is not inside any try — measured, a tool
// rejecting with a self-referencing object took `TypeError: JSON.stringify cannot serialize cyclic
// structures.` straight out of the generator and into cli.ts as an unhandled rejection, turning one
// reportable tool error into a dead process. The fallback is the "[object Object]" this function
// exists to avoid, which is still strictly better than not returning at all — for every value whose
// `String()` is defined, which is every value a provider or an in-repo tool produces. A value that
// defeats JSON.stringify AND String() (a null-prototype cyclic object) still escapes; guarding that
// is padding for a case nothing here can reach.
function errorText(err: unknown): string {
  if (err instanceof Error) return String(err);
  // Already the message. JSON.stringify would hand the user and the model `"ENOENT: no such file"`,
  // quotes included, for a tool that rejected with a bare string.
  if (typeof err === "string") return err;
  try {
    const serialised = JSON.stringify(err) ?? String(err);
    // Nothing in reach produces this today — every AI SDK provider error is an Error subclass and
    // every in-repo tool throws Error — so this fixes no live bug. It caps a payload whose size is
    // the provider's to choose, at a site that puts the result on stderr AND into the model's billed
    // context as the tool result, which is the shape of the 66-line blob onError was silenced for
    // above. Here so the branch cannot become that defect if it ever is reached.
    return serialised.length > MAX_SERIALISED_ERROR_LENGTH
      ? `${serialised.slice(0, MAX_SERIALISED_ERROR_LENGTH)}… (truncated from ${serialised.length} characters)`
      : serialised;
  } catch {
    return String(err);
  }
}

export async function* runLoop(opts: {
  model: LanguageModel;
  tools: ToolSet;
  messages: ModelMessage[];
  permissionMode: PermissionMode;
  approvalPrompt?: ApprovalPrompt;
  // The tools already approved with "always" before this run started, or nothing. A seed, not a
  // handle: the loop copies it into its own Set and never writes back through this reference, so a
  // caller cannot be surprised by a mutation it did not ask for. Growth leaves as `tool-allowed`.
  allowedTools?: readonly string[];
  maxIterations?: number;
  system?: string;
  contextWindowSize?: number;
  compactionThreshold?: number;
  preserveRecentMessages?: number;
  signal?: AbortSignal;
}): AsyncGenerator<LoopEvent> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
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

  let lastInputTokens = 0;
  // Copied, not aliased: opts.allowedTools is a seed the caller owns. Run-local and read on every
  // gate check, so an "always" answer takes effect on the very next call in the same turn — which
  // is the whole point, and is why this cannot live in the caller's copy of anything.
  const allowedTools = new Set<string>(opts.allowedTools ?? []);
  let consecutiveDenials = 0;

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
          // Drained here for the same reason the stream's retries are drained below: compaction is
          // a model call the user never asked for, and until now a 429'd summariser was ~6 s of
          // silence before `⚙ compacted`. compactMessages cannot yield and does no I/O, so its
          // count comes back as a return value and becomes events here — one per retry, before the
          // `compacted` event, because that is the order they happened in.
          for (let attempt = 1; attempt <= compacted.retries; attempt++) {
            yield { type: "retry", attempt };
          }
          yield {
            type: "compacted",
            summary: compacted.summary,
            evictedCount: compacted.evictedCount,
            usage: compacted.usage,
          };
          yield { type: "messages-updated", messages: [...messages] };
        } catch (err) {
          // A cancel lands here as an AbortError, and this catch otherwise reports it and falls
          // through into a fresh streamText call in this same iteration — so the top-of-iteration
          // check above cannot be what stops it. Checked here, where the abort actually surfaces.
          if (opts.signal?.aborted) {
            yield { type: "done", reason: "aborted" };
            return;
          }
          yield { type: "error", error: errorText(err) };
        }
      }
    }

    let text = "";
    const toolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [];

    // streamText runs each attempt inside its retry wrapper (ai@7.0.48 dist/index.js:9684) and
    // notifies onLanguageModelCallStart from inside that closure, immediately before doStream
    // (dist/index.js:8320) — so a second start within one streamText call is a retry, and counting
    // starts is the only way to see one. There is no onRetry, and the callback is handed neither
    // the error that caused the retry nor the delay before it. The count is drained into events in
    // the stream loop below because a callback cannot yield: every attempt finishes before the
    // first part arrives, so the drain is never late. A call that exhausts its retries reaches the
    // drain too, because that failure arrives as an `error` part rather than as a rejection —
    // measured with a doStream that always 429s: three attempts, then `retry` 1, `retry` 2 and
    // `error: AI_RetryError: Failed after 3 attempts`, in that order.
    let modelCallStarts = 0;
    let reportedRetries = 0;

    try {
      const result = streamText({
        model: opts.model,
        tools: schemaOnlyTools,
        messages,
        system: opts.system,
        abortSignal: opts.signal,
        maxRetries: MAX_RETRIES,
        onLanguageModelCallStart: () => {
          modelCallStarts++;
        },
        // ai@7.0.48 defaults this to `({ error }) => console.error(error)` (dist/index.js:8792),
        // which put 66 lines of raw APICallError — request body, every response header including
        // set-cookie, a node_modules stack — on stderr from inside a generator this repo
        // documents as never touching stdout/stdin. Measured for a doStream that rejects — the case
        // the blob came from: the same error also arrives on fullStream as an `error` part and is
        // yielded below, so nothing was silenced there that the consumer does not still get.
        onError: () => {},
      });
      for await (const part of result.fullStream) {
        while (reportedRetries < modelCallStarts - 1) {
          reportedRetries++;
          yield { type: "retry", attempt: reportedRetries };
        }
        if (part.type === "text-delta") {
          text += part.text;
          yield { type: "text-delta", text: part.text };
        } else if (part.type === "tool-call") {
          toolCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
        } else if (part.type === "error") {
          yield { type: "error", error: errorText(part.error) };
          // A call that streamed text and then failed was billed for the text it streamed, and
          // this is the exit that used to drop it. Measured against ai@7.0.48: consuming this
          // part and then awaiting result.usage resolves — with the provider's real numbers
          // ({"inputTokens":900,"outputTokens":7,"totalTokens":907}) when the stream still carried
          // a `finish`, and with an all-undefined usage when the failure cut the stream short. The
          // await does not deadlock on the undrained stream: the `finish` is already through the
          // transform by the time the `error` part reaches this consumer.
          //
          // Caught rather than awaited bare, for the third sub-path: when the failure IS the call
          // — doStream rejecting with its retries exhausted, nothing streamed — result.usage
          // REJECTS with AI_NoOutputGeneratedError. This await is inside the try below, so an
          // uncaught rejection would not escape, it would do something worse: yield a second
          // `error` naming "No output generated" as the failure, on top of the provider's real one.
          // Through Promise.resolve because the SDK types this as a PromiseLike, which has no
          // .catch — it is a real Promise at runtime, but the declared type is what tsc checks.
          const failedUsage = await Promise.resolve(result.usage).catch(() => undefined);
          if (failedUsage !== undefined) yield { type: "usage", usage: failedUsage };
          return;
        }
      }
      const resultUsage = await result.usage;
      lastInputTokens = resultUsage.inputTokens ?? 0;
      // The whole of it, not the one field the compaction trigger above needs: what the call cost
      // is the consumer's question to answer, and narrowing it here is what made it unanswerable.
      yield { type: "usage", usage: resultUsage };
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
      yield { type: "error", error: errorText(err) };
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
    for (const call of toolCalls) {
      // Before the call, therefore upstream of the checkpoint snapshot taken inside the wrapper at
      // toolDef.execute — and this is the only point that sees all seven tools, since wrapTools
      // returns the four non-mutating ones by reference. A tool that has not started cannot leave
      // a half-written file behind.
      if (opts.signal?.aborted) break;

      const permission = checkPermission(call.toolName, opts.permissionMode, allowedTools);
      let approved = permission === "allow";
      let allowedNow = false;
      if (permission === "needs-approval" && opts.approvalPrompt !== undefined) {
        const answer = await opts.approvalPrompt(call.toolName, call.input, opts.signal);
        if (answer === "always") {
          allowedTools.add(call.toolName);
          allowedNow = true;
        }
        approved = answer !== "no";
      }
      // `needs-approval` with no approvalPrompt supplied stays denied, and `block` never reaches the
      // prompt at all — both are what the boolean short-circuit this replaced already did.

      // Re-checked after the prompt, because a cancel that lands while the user is being asked
      // resolves it "no" (cli.ts closes the readline to unpark the turn) and "no" is otherwise
      // indistinguishable from a typed "n". Without this the row below would tell the model the
      // call "was not permitted to run" — a denial the user never made — and the model would resume
      // believing its own tool call had been refused rather than interrupted. Only an await can let
      // an abort in, so this is the one place a second check is needed: the guard above already
      // covers the case where the signal was aborted before the call.
      if (opts.signal?.aborted) break;

      if (allowedNow) yield { type: "tool-allowed", name: call.toolName };

      if (!approved) {
        consecutiveDenials++;
        yield { type: "permission-denied", name: call.toolName };
        toolResults.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: {
            type: "execution-denied",
            reason:
              `Tool "${call.toolName}" was not permitted to run (permission mode: ${opts.permissionMode}). ` +
              `Do not retry this call. Either use a tool that does not write, or tell the user to run ` +
              `/mode to change the permission mode.`,
          },
        });
        continue;
      }
      // Only a write resets the streak. An approved READ (glob, read_file, grep — never blocked by
      // checkPermission) is not progress toward the thing the model was denied; it is exactly what
      // a model padding its retries between denied writes looks like, and counting it as progress
      // would let that padding run the counter down to zero forever. See MAX_CONSECUTIVE_DENIALS.
      if (WRITE_TOOLS.has(call.toolName)) consecutiveDenials = 0;

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
        // A cancelled tool rejects — spawnCollect and runRipgrep both do, and bash, powershell,
        // grep and glob all hand them the signal, which is every tool that spawns anything at all.
        // Without this the cancel would be recorded as a tool that failed and the loop would go on
        // to run the next one — which is precisely what the user pressed Ctrl-C to stop.
        if (opts.signal?.aborted) break;
        const error = `Tool "${call.toolName}" threw during execution: ${errorText(err)}`;
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

    // Every path through the body above either pushes exactly one row and carries on, or breaks, so
    // rows and calls stay index-aligned and whatever is past the end of toolResults was never
    // answered. Derived rather than recorded: an index assigned at each of the three break sites
    // would make the guarantee below depend on three assignments each being right, where this
    // depends on the rows the loop actually pushed.
    const unanswered = toolCalls.slice(toolResults.length);

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
    for (const call of unanswered) {
      toolResults.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "execution-denied", reason: `Tool "${call.toolName}" was cancelled by the user before it completed.` },
      });
    }

    messages.push({ role: "tool", content: toolResults });
    yield { type: "messages-updated", messages: [...messages] };

    // A break is the only way to leave a call unanswered, and all three break sites are the abort
    // checks above, so a non-empty `unanswered` is exactly "the turn was cancelled". Read off the
    // rows the loop actually pushed rather than off a flag, which is one more thing each of those
    // three sites could be written without.
    if (unanswered.length > 0) {
      yield { type: "done", reason: "aborted" };
      return;
    }

    // After the rows are pushed and yielded, never before: a run that stops here must still be
    // resumable, and a turn whose assistant message carries tool calls with no matching tool
    // results is AI_MissingToolResultsError on the next --resume. After the abort return above, so
    // a cancelled turn is reported as cancelled rather than as a denial spiral.
    if (consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
      yield { type: "done", reason: "repeated-denials" };
      return;
    }
  }

  yield { type: "done", reason: "max-iterations" };
}
