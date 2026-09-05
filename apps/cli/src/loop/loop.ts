import { findCatalogEntry, type ModelCatalog, type ModelProvider } from "@seri/model-catalog";
import type {
  AssistantContent,
  JSONValue,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  ToolContent,
  ToolSet,
} from "ai";
import { streamText } from "ai";
import { type ScreenResult, screenCall } from "../containment/escape";
import { checkPermission, type PermissionMode } from "../gate/gate";
import { withCodexStoreOption } from "../provider/codex";
import {
  type CostReport,
  openRouterServedProvider,
  reportForOpenRouter,
  reportForSubscription,
  reportFromCatalogPricing,
} from "../provider/cost";
import { appliedReasoningEffort, buildReasoningProviderOptions } from "../provider/reasoning";
import type { RouteCredential } from "../provider/routing";
import { resolveSampling, samplingCallFields } from "../provider/sampling";
import { READ_ONLY_TOOL_NAMES } from "../provider/tools";
import { streamErrorText } from "../usage/quotaNotice";
import {
  type CompactionSummary,
  compactMessages,
  DEFAULT_PRESERVE_RECENT_TOKENS,
  estimateTokens,
  findSafeEvictionBoundary,
  isContextOverflowError,
  MAX_RETRIES,
} from "./compaction";

export { DEFAULT_PRESERVE_RECENT_TOKENS } from "./compaction";

export type LoopEvent =
  | { type: "text-delta"; text: string }
  // Display-only thought text from fullStream. Not appended to the assistant `text`
  // accumulator — ModelMessage[] / compaction / resume never see it.
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; name: string; args: unknown }
  | { type: "tool-result"; name: string; result: unknown }
  // "blocked" is the mode doing its job (checkPermission returned "block", e.g. read-only on a
  // write) — the user chose that mode and it is behaving exactly as asked. "declined" is a real
  // refusal: the prompt answered "no", or there was no one to ask at all. Only "declined" is a
  // signal about the RUN going wrong; "blocked" is a signal about the MODE working. Consumers that
  // count denials (driveLoop's exit code, this file's own repeated-denials stop) must count only
  // the second — see MAX_CONSECUTIVE_DENIALS. "hook" falls on the "blocked" side of that same line:
  // a PreToolUse hook is configuration the user installed, refusing the call it was installed to
  // refuse, which is the mode argument again in another shape. It must therefore never increment
  // MAX_CONSECUTIVE_DENIALS — that streak counts a human answering no to a live question three
  // times, and there is no human anywhere in a hook's path to answer even once. "containment" is
  // the same kind of rail: the harness refused the call, so a human did not say no.
  | {
      type: "permission-denied";
      name: string;
      reason: "blocked" | "declined" | "hook" | "containment";
    }
  | { type: "messages-updated"; messages: ModelMessage[] }
  | {
      type: "compacted";
      summary: CompactionSummary;
      evictedCount: number;
      usage: LanguageModelUsage;
      tokensBefore: number;
    }
  // Per completed model call, not a running total: the loop is stateless by design and summing
  // across turns is the consumer's business. `usage` on `compacted` is the same quantity for the
  // summariser's own round-trip, which is billed like any other and was invisible until now.
  // `cost` is only populated on the successful-call path (opts.provider/modelId/catalog supplied);
  // absent on the failed-mid-stream usage yield below and whenever the caller omits those opts.
  | { type: "usage"; usage: LanguageModelUsage; cost?: CostReport; servedProvider?: string }
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
  | {
      type: "done";
      reason: "no-tool-call" | "max-iterations" | "aborted" | "repeated-denials" | "plan-submitted";
    }
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

export type ApprovalPrompt = (
  toolName: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<ApprovalAnswer>;

// Hermes' documented default (see docs-tmp research); now reachable from the CLI via
// --max-turns, where it was previously hardcoded and unconfigurable.
const DEFAULT_MAX_ITERATIONS = 500;
// Consecutive DECLINED calls — a live "no" at the prompt, never a mode block — reset by any
// approved call, after which the run stops instead of continuing to the iteration cap. Counting
// only declines (not blocks) is what confines this stop to approve-each: checkPermission returns
// "block" for every write in read-only, never "needs-approval", so a read-only session can never
// produce a decline at all — a session that probes a write three times, a hundred turns apart,
// stays entirely unaffected by this constant no matter how many times it happens. In approve-each,
// where a decline means a human answered "no" to a live question, three in a row is a real signal.
// The trade this accepts: a model COULD pad declined retries with an approved read to keep
// resetting the counter and never trip this stop. That evasion is theoretical, not measured —
// nothing has observed a real model doing it — and two things already sit under it if it ever
// happens: the iteration cap is the backstop that still ends the run, and the denial text (below)
// tells the model the permission mode and tells it not to retry, so a model that pads anyway is
// ignoring an instruction, not exploiting a gap nobody warned it about. Counted in CALLS, not
// turns: a turn that emits three write calls and has all three declined is the same fact as three
// declined turns, and counting turns would let that turn repeat 500 times. Three rather than one
// because a single decline is normal (the user says no to one thing and the model does something
// else) and because the model is now told the mode and told not to retry, so three is "it was told
// twice and did it again".
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
export const DEFAULT_CONTEXT_WINDOW_SIZE = 131_072;
export const DEFAULT_COMPACTION_THRESHOLD = 0.5;

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

// "allow-new" rather than a boolean-plus-flag: a fresh grant needs to reach the loop as a single
// fact ("this call is allowed, AND it is the first time"), and this is the one place that fact is
// produced, so it owns the gate check, the prompt call and the allowedTools.add together instead
// of the caller reassembling them from two mutable locals. Deliberately does NOT own the
// signal?.aborted re-check after the prompt: that has to sit in the loop body, between this
// function's return and the branch that reads it, because it is what tells a cancel-while-parked
// apart from a typed "n" — moving it in here would put it before the loop's own read of the
// verdict, which is exactly the reordering that guarantee depends on not happening.
// Two ways to "deny", carried out as two verdicts rather than one so the loop can count only the
// one that is a signal about the run: "deny-blocked" is the mode doing its job (checkPermission
// returned "block", or there was no approvalPrompt to ask at all — the same as block, just
// arrived at differently, because there is still no one to ask); "deny-declined" is a real
// refusal — a live prompt that answered "no". Only the second should ever increment a denial
// counter or flip an exit code; see MAX_CONSECUTIVE_DENIALS and driveLoop's own comment.
async function decidePermission(
  toolName: string,
  input: unknown,
  mode: PermissionMode,
  allowedTools: Set<string>,
  approvalPrompt: ApprovalPrompt | undefined,
  signal: AbortSignal | undefined,
): Promise<"allow" | "allow-new" | "deny-blocked" | "deny-declined"> {
  const permission = checkPermission(toolName, mode, allowedTools);
  if (permission === "allow") return "allow";
  if (permission === "block") return "deny-blocked";
  if (approvalPrompt === undefined) return "deny-blocked";
  const answer = await approvalPrompt(toolName, input, signal);
  if (answer === "always") {
    allowedTools.add(toolName);
    return "allow-new";
  }
  return answer === "no" ? "deny-declined" : "allow";
}

function isConcurrentReadTool(name: string): boolean {
  return (READ_ONLY_TOOL_NAMES as readonly string[]).includes(name);
}

export async function* runLoop(opts: {
  model: LanguageModel;
  tools: ToolSet;
  messages: ModelMessage[];
  permissionMode: PermissionMode;
  approvalPrompt?: ApprovalPrompt;
  /** The name a tool call answers to at the gate, at the approval prompt, and in the events a
   *  consumer renders. A composite tool can carry its real subject in its input; everything else
   *  answers to its own name. Optional and pure — omitting it leaves behaviour byte-identical. */
  callSubject?: (toolName: string, input: unknown) => string;
  /**
   * Called at the very end of each tool round, with the calls whose `execute` actually resolved.
   * Returning text appends it to `messages` as a user message the model sees on its next call
   * within the same turn; returning undefined appends nothing.
   *
   * Deliberately rule-ignorant and synchronous. The loop is a library: it does not know what a
   * project rule is, only that its consumer may have something to say about what was just touched.
   * Synchronous because it runs between a tool round and the next model call, where an await would
   * add latency to every turn for the benefit of the sessions that have no rules at all.
   */
  onToolPhaseEnd?: (
    executed: readonly { toolName: string; input: unknown }[],
  ) => string | undefined;
  /**
   * Consulted before the gate, per call, with the resolved `subject` rather than `call.toolName` —
   * the rule this file already states for every string a model or a human reads applies to a
   * consumer's matcher too, and one reading the raw ToolSet key would see every MCP call as the
   * literal "mcp".
   *
   * Ahead of the gate, and that ordering is load-bearing rather than incidental: it is the argument
   * the unknown-tool guard's own comment makes one branch further down. A human must never be asked
   * to approve a call that is about to be refused anyway, and a block reached only after the prompt
   * could be answered "always" and never asked about again — which is the whole determinism claim
   * gone.
   *
   * Asynchronous, where onToolPhaseEnd above is deliberately synchronous, and it leans on the same
   * mitigation that one relies on: a consumer with nothing to say returns undefined from its own
   * factory, so this opt is undefined and a session with no hooks at all adds no `await` to the
   * path every tool call takes.
   *
   * `errors` are reported and the call goes ahead; only `block` stops it. A hook that could not run
   * has expressed no opinion, and a broken formatter must not be able to stop the agent working.
   */
  onBeforeTool?: (
    subject: string,
    input: unknown,
  ) => Promise<{ readonly block?: string; readonly errors?: readonly string[] }>;
  /**
   * Consulted after a call's result has been recorded, with the same resolved subject. Everything
   * it returns is reported as `error` events and nothing it returns can stop anything: the tool has
   * already run, so a consumer with an objection at this point has a message, not a veto.
   */
  onAfterTool?: (subject: string, input: unknown, result: unknown) => Promise<readonly string[]>;
  // Host annotation for the containment-escape table. Default false. The loop always screens;
  // this flag only skips table hits, never an unparseable inspectable payload.
  containmentEscapeExpected?: boolean;
  // The tools already approved with "always" before this run started, or nothing. A seed, not a
  // handle: the loop copies it into its own Set and never writes back through this reference, so a
  // caller cannot be surprised by a mutation it did not ask for. Growth leaves as `tool-allowed`.
  allowedTools?: readonly string[];
  maxIterations?: number;
  system?: string;
  contextWindowSize?: number;
  compactionThreshold?: number;
  preserveRecentTokens?: number;
  signal?: AbortSignal;
  // Which provider opts.model was constructed from, and the catalog to look it up in — both
  // optional so every existing caller (none of which pass these yet) keeps today's behaviour
  // unchanged. Used for the `usage` event's `cost` field (below) and, via the catalog entry's own
  // `contextWindow`, as a fallback for contextWindowSize when the caller did not pass one
  // explicitly. `modelId` is threaded in rather than read off opts.model: the loop takes an
  // already-built LanguageModel and does not introspect it (see the file-level provider-swap
  // contract), the same reason contextWindowSize itself is already a plain passed-in number.
  provider?: ModelProvider;
  modelId?: string;
  catalog?: ModelCatalog;
  // Which credential paid for this turn. Only the cost report reads it: a subscription turn is
  // flat-rate, so pricing it from the catalog would bill the user for tokens they already bought.
  // Optional like the three above, so a caller that does not pass it keeps today's behaviour.
  credential?: RouteCredential;
  // The resolved reasoning-effort tier (session /effort override or config default —
  // resolution happens in driveLoop, this is just the winning
  // value). Requires opts.provider too, to know which provider-options shape to build.
  reasoningEffort?: string;
  // Configured sampling. The loop applies the provider×credential matrix itself —
  // a Codex subscription child must not inherit a Groq parent's seed.
  temperature?: number;
  seed?: number;
  terminalTools?: ReadonlySet<string>;
}): AsyncGenerator<LoopEvent> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const catalogEntry =
    opts.catalog && opts.provider && opts.modelId
      ? findCatalogEntry(opts.catalog, opts.modelId, opts.provider)
      : undefined;
  const contextWindowSize =
    opts.contextWindowSize ?? catalogEntry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW_SIZE;
  // Re-validated against the CURRENTLY resolved catalogEntry, not just trusted from whatever set
  // it: a route can change between when a tier was set and when a turn actually sends it — e.g.
  // `/effort xhigh` on a route where it's legal, then `/model` switches to a route where `xhigh`
  // isn't legal or the entry has no reasoningOptions at all. An illegal tier is silently dropped
  // (not sent, and this never fails the turn) — missing or stale catalog data degrades to "no
  // control offered" rather than a hard failure.
  // `appliedReasoningEffort`, not an inline check: cli.ts's own persist-on-success gate needs to
  // know the SAME answer this line computes — whether the tier actually sitting in session state
  // was, or was not, applied to the turn that just succeeded — and a shared function is what keeps
  // the two from silently disagreeing.
  const legalReasoningEffort = appliedReasoningEffort(opts.reasoningEffort, catalogEntry);
  const sampling = resolveSampling(opts.provider, opts.credential, {
    temperature: opts.temperature,
    seed: opts.seed,
  });
  const samplingFields = samplingCallFields(sampling);
  const compactionThreshold = opts.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const preserveRecentTokens = opts.preserveRecentTokens ?? DEFAULT_PRESERVE_RECENT_TOKENS;
  const messages: ModelMessage[] = [...opts.messages];

  // The AI SDK auto-runs a tool's `execute` while streaming. Strip it so every
  // tool call is surfaced as an event instead, and runs only after the gate below.
  const schemaOnlyTools = Object.fromEntries(
    Object.entries(opts.tools).map(([name, def]) => {
      const { execute: _execute, ...rest } = def;
      return [name, rest];
    }),
  ) as ToolSet;

  async function* tryCompact(
    onSummarizerFail: "soft" | "hard",
  ): AsyncGenerator<LoopEvent, "ok" | "skipped" | "failed" | "aborted"> {
    const evictBoundary = findSafeEvictionBoundary(messages, preserveRecentTokens);
    if (evictBoundary === null) return "skipped";
    try {
      const compacted = await compactMessages(messages, opts.model, evictBoundary, opts.signal, {
        stream: opts.credential === "subscription" && opts.provider === "openai",
        ...samplingFields,
      });
      messages.splice(0, messages.length, ...compacted.messages);
      for (let attempt = 1; attempt <= compacted.retries; attempt++) {
        yield { type: "retry", attempt };
      }
      yield {
        type: "compacted",
        summary: compacted.summary,
        evictedCount: compacted.evictedCount,
        usage: compacted.usage,
        tokensBefore: compacted.tokensBefore,
      };
      yield { type: "messages-updated", messages: [...messages] };
      return "ok";
    } catch (err) {
      if (opts.signal?.aborted) {
        yield { type: "done", reason: "aborted" };
        return "aborted";
      }
      yield { type: "error", error: errorText(err) };
      return onSummarizerFail === "hard" ? "failed" : "skipped";
    }
  }

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

    const tokens = Math.max(lastInputTokens, estimateTokens(messages));
    if (tokens / contextWindowSize >= compactionThreshold) {
      const thresholdOutcome = yield* tryCompact("soft");
      if (thresholdOutcome === "aborted") return;
    }

    let text = "";
    const toolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [];
    let overflowRetried = false;

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

    const reasoningOptions =
      legalReasoningEffort && opts.provider
        ? buildReasoningProviderOptions(opts.provider, legalReasoningEffort)
        : undefined;
    const providerOptions = withCodexStoreOption(opts.provider, opts.credential, reasoningOptions);

    streamAttempt: while (true) {
      text = "";
      toolCalls.length = 0;
      modelCallStarts = 0;
      reportedRetries = 0;

      try {
        const result = streamText({
          model: opts.model,
          tools: schemaOnlyTools,
          messages,
          system: opts.system,
          abortSignal: opts.signal,
          maxRetries: MAX_RETRIES,
          ...samplingFields,
          ...(providerOptions ? { providerOptions } : {}),
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
          } else if (part.type === "reasoning-delta") {
            if (part.text.length > 0) {
              yield { type: "reasoning-delta", text: part.text };
            }
          } else if (part.type === "tool-call") {
            toolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            });
          } else if (part.type === "error") {
            if (!overflowRetried && isContextOverflowError(part.error)) {
              const overflowOutcome = yield* tryCompact("hard");
              if (overflowOutcome === "aborted") return;
              if (overflowOutcome === "ok") {
                overflowRetried = true;
                continue streamAttempt;
              }
            }
            yield { type: "error", error: streamErrorText(part.error, errorText) };
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
            if (failedUsage !== undefined) {
              // A code-review finding, not hypothetical: this path used to yield `usage` with no
              // `cost` field at all, which `addCost` (cli.ts) treats identically to "nothing new
              // happened" — real billed tokens from a turn that streamed partway then failed would
              // silently vanish from the running total instead of degrading it to `unknown`.
              let failedCost: CostReport | undefined;
              let failedServed: string | undefined;
              if (opts.credential === "subscription") {
                failedCost = reportForSubscription();
              } else if (opts.provider === "openrouter") {
                const providerMetadata = await Promise.resolve(result.providerMetadata).catch(
                  () => undefined,
                );
                failedCost = reportForOpenRouter(failedUsage, providerMetadata);
                failedServed = openRouterServedProvider(providerMetadata);
              } else if (opts.provider && opts.modelId && opts.catalog) {
                failedCost = reportFromCatalogPricing(
                  opts.modelId,
                  opts.provider,
                  failedUsage,
                  opts.catalog,
                );
              }
              yield {
                type: "usage",
                usage: failedUsage,
                cost: failedCost,
                ...(failedServed !== undefined ? { servedProvider: failedServed } : {}),
              };
            }
            return;
          }
        }
        const resultUsage = await result.usage;
        lastInputTokens = resultUsage.inputTokens ?? 0;
        // Dollar cost, tagged with its provenance, alongside the raw usage. Only computed when the
        // caller told us which provider/model/catalog this call used — providerMetadata is a Promise
        // on streamText results (per reportForOpenRouter's own comment) and is only awaited for the
        // provider that actually carries it.
        let cost: CostReport | undefined;
        let servedProvider: string | undefined;
        if (opts.credential === "subscription") {
          cost = reportForSubscription();
        } else if (opts.provider === "openrouter") {
          // A code-review finding: unguarded, a rejection here (providerMetadata is a Promise per
          // reportForOpenRouter's own comment) would escape to the catch below and convert an
          // already-successfully-completed turn into a lost `error` — discarding the text/tool-calls
          // that already finished. Same treatment as the sibling `result.usage` await a few lines up.
          const providerMetadata = await Promise.resolve(result.providerMetadata).catch(
            () => undefined,
          );
          cost = reportForOpenRouter(resultUsage, providerMetadata);
          servedProvider = openRouterServedProvider(providerMetadata);
        } else if (opts.provider && opts.modelId && opts.catalog) {
          cost = reportFromCatalogPricing(opts.modelId, opts.provider, resultUsage, opts.catalog);
        }
        // The whole of it, not the one field the compaction trigger above needs: what the call cost
        // is the consumer's question to answer, and narrowing it here is what made it unanswerable.
        yield {
          type: "usage",
          usage: resultUsage,
          cost,
          ...(servedProvider !== undefined ? { servedProvider } : {}),
        };
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
        if (!overflowRetried && isContextOverflowError(err)) {
          const overflowOutcome = yield* tryCompact("hard");
          if (overflowOutcome === "aborted") return;
          if (overflowOutcome === "ok") {
            overflowRetried = true;
            continue;
          }
        }
        yield { type: "error", error: streamErrorText(err, errorText) };
        return;
      }

      break;
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
      assistantContent.push({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      });
    }
    messages.push({ role: "assistant", content: assistantContent });
    yield { type: "messages-updated", messages: [...messages] };

    const toolResults: ToolContent = [];
    // Only the calls whose `execute` resolved, for onToolPhaseEnd below. Rebuilt per iteration, not
    // per turn: the callback answers for the round that just ran.
    const executed: { toolName: string; input: unknown }[] = [];

    type ToolCall = (typeof toolCalls)[number];
    type ReadOutcome =
      | { kind: "ok"; value: unknown }
      | { kind: "error"; error: unknown }
      | { kind: "aborted" };
    type ReadBatchItem = {
      call: ToolCall;
      subject: string;
      yieldedCall: boolean;
      outcome: Promise<ReadOutcome>;
    };
    const readBatch: ReadBatchItem[] = [];

    type ToolExecute = NonNullable<NonNullable<(typeof opts.tools)[string]>["execute"]>;
    const startReadExecute = (call: ToolCall, execute: ToolExecute): Promise<ReadOutcome> =>
      // `then`, not `Promise.resolve(execute(...))`: read_file's execute is sync
      // (readFileSync) and throws. Evaluating that call as the argument throws
      // before a promise exists, so the rejection handler below never runs and
      // the raw ENOENT escapes the generator — TUI death, not a tool-error event.
      Promise.resolve()
        .then(() =>
          execute(call.input, {
            toolCallId: call.toolCallId,
            messages,
            context: {},
            abortSignal: opts.signal,
          }),
        )
        .then(
          (value): ReadOutcome => ({ kind: "ok", value }),
          (error): ReadOutcome =>
            opts.signal?.aborted ? { kind: "aborted" } : { kind: "error", error },
        );

    async function* flushReadBatch(): AsyncGenerator<LoopEvent, "aborted" | "ok"> {
      if (readBatch.length === 0) return "ok";
      const items = readBatch.splice(0, readBatch.length);
      const outcomes = await Promise.all(items.map((item) => item.outcome));
      let aborted = false;
      for (const [i, item] of items.entries()) {
        const out = outcomes[i];
        if (out === undefined) continue;
        if (!item.yieldedCall) {
          if (out.kind === "aborted") {
            aborted = true;
            continue;
          }
          yield { type: "tool-call", name: item.subject, args: item.call.input };
        }
        if (out.kind === "aborted") {
          aborted = true;
          continue;
        }
        if (out.kind === "error") {
          const error = `Tool "${item.subject}" threw during execution: ${errorText(out.error)}`;
          yield { type: "error", error };
          toolResults.push({
            type: "tool-result",
            toolCallId: item.call.toolCallId,
            toolName: item.call.toolName,
            output: { type: "error-text", value: error },
          });
          continue;
        }
        yield { type: "tool-result", name: item.subject, result: out.value };
        executed.push({ toolName: item.call.toolName, input: item.call.input });
        toolResults.push({
          type: "tool-result",
          toolCallId: item.call.toolCallId,
          toolName: item.call.toolName,
          output: { type: "json", value: (out.value ?? null) as JSONValue },
        });
        if (opts.onAfterTool !== undefined) {
          let afterMessages: readonly string[];
          try {
            afterMessages = await opts.onAfterTool(item.subject, item.call.input, out.value);
          } catch (err) {
            if (opts.signal?.aborted) return "aborted";
            throw err;
          }
          for (const error of afterMessages) yield { type: "error", error };
        }
      }
      return aborted || opts.signal?.aborted === true ? "aborted" : "ok";
    }

    let terminalHit = false;
    for (const call of toolCalls) {
      // Before the call, therefore upstream of the checkpoint snapshot taken inside the wrapper at
      // toolDef.execute — and this is the only point that sees all seven tools, since wrapTools
      // returns the four non-mutating ones by reference. A tool that has not started cannot leave
      // a half-written file behind.
      if (opts.signal?.aborted) break;

      // Existence first, permission second, and that order is load-bearing rather than incidental.
      // The gate classifies a name it does not recognise as `write` (provider/tools.ts), which is
      // the right answer for a third-party tool and the wrong one for a tool that does not exist.
      // Gated first, a name the model invented comes back `deny-blocked` in read-only and the row
      // below would tell the model its call "was not permitted to run … tell the user to run
      // /mode": a permission diagnosis, a permission remedy, and an explicit instruction not to
      // retry, for a call no mode could ever have run. In approve-each it is worse — the human is
      // asked to approve a tool that cannot run. "No such tool" is the only true answer, and it
      // costs nothing to give it first.
      const toolDef = opts.tools[call.toolName];
      if (!toolDef?.execute) {
        if ((yield* flushReadBatch()) === "aborted") break;
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

      // The rule, not a list of sites: every string a MODEL or a HUMAN reads — the gate, the
      // approval prompt, an `error`/`execution-denied` reason, any event name a consumer renders —
      // names `subject`. Every field a PROVIDER matches against the tool-call it emitted — the
      // `opts.tools[...]` lookup, and the `toolName` field of every row pushed into `toolResults` —
      // stays `call.toolName`, the literal ToolSet key. A composite tool (the `mcp` tool composed
      // by mcp/tool.ts, for instance) carries the call it actually means in its input, so the two
      // can disagree; telling the model a tool has two different names within one turn is an
      // invitation to retry under the wrong one.
      const subject = opts.callSubject?.(call.toolName, call.input) ?? call.toolName;

      // Before onBeforeTool and the gate so a human is never asked about a call this rail will
      // refuse, and so auto / --dangerously-skip-permissions cannot reach around it. A throw is a
      // block — the opposite of onBeforeTool.errors, which proceed.
      let containment: ScreenResult;
      try {
        containment = screenCall(subject, call.input, opts.containmentEscapeExpected === true);
      } catch {
        containment = {
          outcome: "block",
          reason: { kind: "unparseable", detail: "could not evaluate" },
        };
      }
      if (containment.outcome === "block") {
        if ((yield* flushReadBatch()) === "aborted") break;
        yield { type: "permission-denied", name: subject, reason: "containment" };
        const named =
          containment.reason.kind === "escape"
            ? `${containment.reason.class} (${containment.reason.label})`
            : `unparseable (${containment.reason.detail})`;
        toolResults.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: {
            type: "execution-denied",
            reason:
              `Tool "${subject}" was blocked as a containment escape: ${named}. ` +
              `Do not retry this call or a variant of it. The block is a harness rail; ` +
              `/mode and --dangerously-skip-permissions do not lift it.`,
          },
        });
        continue;
      }

      if (opts.onBeforeTool !== undefined) {
        let hook: { readonly block?: string; readonly errors?: readonly string[] };
        try {
          hook = await opts.onBeforeTool(subject, call.input);
        } catch (err) {
          // A cancelled hook rejects, the same way a cancelled tool's `execute` does, and it needs
          // the same catch for the same reason. Measured before this existed: the rejection escaped
          // the generator entirely, so the turn produced no `done` event and left the assistant
          // message's tool call without a matching tool-result row — AI_MissingToolResultsError on
          // the next --resume, which is the one thing a cancel must not cause. Breaking here hands
          // the call to the unanswered-row loop below, exactly as every other cancel site does.
          if (opts.signal?.aborted) break;
          throw err;
        }
        // The TUI treats an `error` event while `pendingTool` is set as that in-flight call
        // throwing. A later read's PreToolUse can fail without blocking and still run; flushing
        // first closes the previous read's call/result pair so this error is a system line, not a
        // false throw on a sibling that actually succeeded.
        if ((hook.errors?.length ?? 0) > 0 && (yield* flushReadBatch()) === "aborted") break;
        for (const error of hook.errors ?? []) yield { type: "error", error };
        // A new await is a new window for an abort to land in, and a check placed after a different
        // await does not cover it — same reason as the re-check below, whose comment spells the
        // argument out. Without this a cancel lands as a hook verdict.
        if (opts.signal?.aborted) break;
        if (hook.block !== undefined) {
          if ((yield* flushReadBatch()) === "aborted") break;
          yield { type: "permission-denied", name: subject, reason: "hook" };
          toolResults.push({
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: {
              type: "execution-denied",
              reason:
                `Tool "${subject}" was blocked by a project hook: ${hook.block} ` +
                `Do not retry this call. The block is deterministic and asking again will not change it.`,
            },
          });
          continue;
        }
      }

      const verdict = await decidePermission(
        subject,
        call.input,
        opts.permissionMode,
        allowedTools,
        opts.approvalPrompt,
        opts.signal,
      );

      // Re-checked after the prompt, because a cancel that lands while the user is being asked
      // resolves it "no" (cli.ts closes the readline to unpark the turn) and "no" is otherwise
      // indistinguishable from a typed "n". Without this the row below would tell the model the
      // call "was not permitted to run" — a denial the user never made — and the model would resume
      // believing its own tool call had been refused rather than interrupted. Only an await can let
      // an abort in, so this is the one place a second check is needed: the guard above already
      // covers the case where the signal was aborted before the call. Stays here rather than
      // inside decidePermission on purpose — see that function's own comment.
      if (opts.signal?.aborted) break;

      if (verdict === "allow-new") yield { type: "tool-allowed", name: subject };

      if (verdict === "deny-blocked" || verdict === "deny-declined") {
        if ((yield* flushReadBatch()) === "aborted") break;
        // Only a declined call is a signal about the RUN — a blocked one is the mode working as
        // the user asked. See MAX_CONSECUTIVE_DENIALS.
        if (verdict === "deny-declined") consecutiveDenials++;
        yield {
          type: "permission-denied",
          name: subject,
          reason: verdict === "deny-blocked" ? "blocked" : "declined",
        };
        toolResults.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: {
            type: "execution-denied",
            reason:
              `Tool "${subject}" was not permitted to run (permission mode: ${opts.permissionMode}). ` +
              `Do not retry this call. Either use a tool that does not write, or tell the user to run ` +
              `/mode to change the permission mode.`,
          },
        });
        continue;
      }

      // Any approved call resets the streak, and by this line the call is known to have a tool
      // definition behind it: the unknown-tool guard runs ahead of the gate, so a call that never
      // actually ran can no longer reach here and count as the reason to keep trying. Not
      // write-only: in read-only mode checkPermission blocks every write, so no write is EVER
      // approved there, and a write-only reset would mean consecutiveDenials counts "denied write
      // attempts this run" instead of "denied calls in a row" — a long, productive read-heavy
      // session (`seri --continue "review this repo and tell me what to change"`) that happens to
      // probe a write three times, scattered turns apart, would die at repeated-denials having
      // done nothing wrong. See MAX_CONSECUTIVE_DENIALS for the padding risk this accepts instead.
      consecutiveDenials = 0;

      if (isConcurrentReadTool(call.toolName)) {
        const execute = toolDef.execute;
        if (readBatch.length === 0) {
          yield { type: "tool-call", name: subject, args: call.input };
          readBatch.push({
            call,
            subject,
            yieldedCall: true,
            outcome: startReadExecute(call, execute),
          });
        } else {
          readBatch.push({
            call,
            subject,
            yieldedCall: false,
            outcome: startReadExecute(call, execute),
          });
        }
        continue;
      }

      if ((yield* flushReadBatch()) === "aborted") break;

      yield { type: "tool-call", name: subject, args: call.input };
      let toolResult: unknown;
      try {
        toolResult = await toolDef.execute(call.input, {
          toolCallId: call.toolCallId,
          messages,
          context: {},
          abortSignal: opts.signal,
        });
        if (opts.terminalTools?.has(call.toolName)) terminalHit = true;
      } catch (err) {
        // A cancelled tool rejects — spawnCollect and runRipgrep both do, and bash, powershell,
        // grep and glob all hand them the signal, which is every tool that spawns anything at all.
        // Without this the cancel would be recorded as a tool that failed and the loop would go on
        // to run the next one — which is precisely what the user pressed Ctrl-C to stop.
        if (opts.signal?.aborted) break;
        const error = `Tool "${subject}" threw during execution: ${errorText(err)}`;
        yield { type: "error", error };
        toolResults.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "error-text", value: error },
        });
        continue;
      }
      yield { type: "tool-result", name: subject, result: toolResult };
      executed.push({ toolName: call.toolName, input: call.input });
      toolResults.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "json", value: (toolResult ?? null) as JSONValue },
      });

      // After both pushes above, never before. A post hook that returns once a cancel has already
      // landed must not cost this call its row: the assistant message carrying the call is pushed
      // and persisted by now, so a missing row is AI_MissingToolResultsError on the next --resume —
      // the argument the unanswered-row loop and the repeated-denials stop below each make for
      // their own site, applied to a third one. The next iteration's abort check then breaks, and
      // the unanswered-row loop fills in every call behind this one.
      if (opts.onAfterTool !== undefined) {
        let afterMessages: readonly string[];
        try {
          afterMessages = await opts.onAfterTool(subject, call.input, toolResult);
        } catch (err) {
          // Same catch as the pre-hook above and as the `execute` call itself: a cancelled hook
          // rejects, and an escaping rejection would take the generator down without a `done`
          // event. This call already has its row, so breaking here loses nothing.
          if (opts.signal?.aborted) break;
          throw err;
        }
        for (const error of afterMessages) yield { type: "error", error };
      }
    }

    yield* flushReadBatch();

    // Parallel reads can finish out of start order, so a missing row is identified by toolCallId
    // rather than as a suffix of `toolCalls`. A break still leaves every unfinished call without a
    // row; the fill below answers them. Completed reads keep the result they actually produced.
    const answeredIds = new Set(
      toolResults.flatMap((row) => ("toolCallId" in row ? [row.toolCallId] : [])),
    );
    const unanswered = toolCalls.filter((call) => !answeredIds.has(call.toolCallId));

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
      // Same rule as the block above: the reason text is read by the model, so it names the
      // subject. This loop runs outside that block, so the expression is recomputed here.
      const subject = opts.callSubject?.(call.toolName, call.input) ?? call.toolName;
      toolResults.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: {
          type: "execution-denied",
          reason: `Tool "${subject}" was cancelled by the user before it completed.`,
        },
      });
    }

    messages.push({ role: "tool", content: toolResults });
    yield { type: "messages-updated", messages: [...messages] };

    // A break or an aborted in-flight read is the way a call is left unanswered. Read off the
    // rows the loop actually pushed rather than off a flag, which is one more thing each abort
    // site could be written without.
    if (unanswered.length > 0) {
      yield { type: "done", reason: "aborted" };
      return;
    }

    // After the unanswered abort, so a cancelled round is still "aborted" even if a terminal
    // tool had already succeeded in the same batch. After the rows, so a plan-submitted turn
    // stays resumable.
    if (terminalHit) {
      yield { type: "done", reason: "plan-submitted" };
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

    // The last thing the iteration does, after both early returns above, so a cancelled or
    // denial-terminated phase reaches nothing here. The loop stays ignorant of what the callback is
    // for: it hands over the calls whose `execute` actually resolved and appends whatever text
    // comes back as an ordinary user message. Denied, unknown-tool, thrown and cancelled calls are
    // excluded by construction, because none of them reach the push above.
    //
    // A message rather than a mutation of `opts.system`: the messages array is append-only and
    // already grows every round, so a provider's prefix cache diverges only at the tail. Rewriting
    // the system string would move the divergence point in front of the entire conversation and
    // re-bill every message token uncached.
    const appended = executed.length === 0 ? undefined : opts.onToolPhaseEnd?.(executed);
    if (appended !== undefined && appended.length > 0) {
      messages.push({ role: "user", content: [{ type: "text", text: appended }] });
      yield { type: "messages-updated", messages: [...messages] };
    }
  }

  yield { type: "done", reason: "max-iterations" };
}
