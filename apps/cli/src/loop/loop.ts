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
import { type AutoModeOnBlock, type ToolCallClassifier } from "../gate/classifier";
import { type Consent, decideFsPolicy, reduceConsent } from "../gate/fsBoundary";
import { checkPermission, denialBlocks, type PathDenial, type PermissionMode } from "../gate/gate";
import {
  findPackedRendererUpload,
  humanAskedForPackedRender,
  lastUserText,
  packedUploadAppliesTo,
} from "../gate/packedRenderer";
import { locationForCall } from "../gate/workingDir";
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
import { classifyBuiltin, READ_ONLY_TOOL_NAMES } from "../provider/tools";
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
  // Display-only fullStream thought text; never appended to assistant text or persisted.
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; name: string; args: unknown }
  | { type: "tool-result"; name: string; result: unknown }
  // "declined" is a live human no; `blocked`, `hook`, and `containment` must not increment consecutiveDenials.
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
  // One completed model call's usage, not a running total; `cost` is present only when provider, modelId, and catalog were supplied.
  | { type: "usage"; usage: LanguageModelUsage; cost?: CostReport; servedProvider?: string }
  // ai@7.0.48 exposes no per-attempt error or delay; `attempt` is 1-based for the current model call.
  | { type: "retry"; attempt: number }
  // Emitted when an always-grant is added to the live Set, before that tool runs.
  | { type: "tool-allowed"; name: string }
  // "aborted" is a `done` reason, not `error`, so printers do not send AbortError to stderr.
  | {
      type: "done";
      reason: "no-tool-call" | "max-iterations" | "aborted" | "repeated-denials" | "plan-submitted";
    }
  | { type: "error"; error: string };

export type ApprovalAnswer = "once" | "always" | "no";

export type ApprovalDetail = {
  readonly classifierReason?: string;
};

export type ApprovalPrompt = (
  toolName: string,
  args: unknown,
  signal?: AbortSignal,
  detail?: ApprovalDetail,
) => Promise<ApprovalAnswer>;

const DEFAULT_MAX_ITERATIONS = 500;
const MAX_CONSECUTIVE_DENIALS = 3;
export const DEFAULT_CONTEXT_WINDOW_SIZE = 131_072;
export const DEFAULT_COMPACTION_THRESHOLD = 0.5;

const MAX_SERIALISED_ERROR_LENGTH = 500;

// Groq (and other providers) reject with a plain object whose String() is "[object Object]"; JSON.stringify throws on cycles.
function errorText(err: unknown): string {
  let text: string;
  if (err instanceof Error) text = String(err);
  // JSON.stringify of a bare string wraps it in quotes.
  else if (typeof err === "string") text = err;
  else {
    try {
      text = JSON.stringify(err) ?? String(err);
    } catch {
      text = String(err);
    }
  }
  return text.length > MAX_SERIALISED_ERROR_LENGTH
    ? `${text.slice(0, MAX_SERIALISED_ERROR_LENGTH)}… (truncated from ${text.length} characters)`
    : text;
}

type PermissionVerdict =
  | { kind: "allow" | "allow-new" }
  | { kind: "deny-blocked" | "deny-declined"; reason: string };

async function decidePermission(args: {
  subject: string;
  toolName: string;
  input: unknown;
  mode: PermissionMode;
  allowedTools: Set<string>;
  approvalPrompt: ApprovalPrompt | undefined;
  signal: AbortSignal | undefined;
  denials: readonly PathDenial[] | undefined;
  cwd: string | undefined;
  turnUserText: string;
  workingDirectory: string | undefined;
  standingDeny: boolean;
  askOutsideFs: boolean;
  consent: { current: Consent };
  classifyToolCall: ToolCallClassifier | undefined;
  autoModeOnBlock: AutoModeOnBlock;
}): Promise<PermissionVerdict> {
  if (args.mode === "auto" && packedUploadAppliesTo(args.toolName)) {
    const upload = findPackedRendererUpload(args.input);
    if (upload !== null && !humanAskedForPackedRender(args.turnUserText)) {
      return {
        kind: "deny-blocked",
        reason:
          `Tool "${args.subject}" was not permitted to run: packing repo or user content into a public ` +
          `diagram-renderer URL is a ${upload.class} to ${upload.host}, and auto mode does not ` +
          `approve that unless the user asked for the render or export this turn. Do not retry ` +
          `this call.`,
      };
    }
  }
  if (args.workingDirectory !== undefined) {
    const fsVerdict = decideFsPolicy({
      mode: args.mode,
      toolClass: classifyBuiltin(args.toolName),
      location: locationForCall(args.workingDirectory, args.toolName, args.input),
      consent: args.consent.current,
      standingDeny: args.standingDeny,
      hasPrompt: args.askOutsideFs,
    });
    if (fsVerdict === "block") {
      return {
        kind: "deny-blocked",
        reason:
          `Tool "${args.subject}" was not permitted to run because its path is outside the working directory. ` +
          `Do not retry this call. Stay inside the working directory, or tell the user to allow outside access for this run.`,
      };
    }
    if (fsVerdict === "ask") {
      if (args.approvalPrompt === undefined) {
        return {
          kind: "deny-blocked",
          reason:
            `Tool "${args.subject}" was not permitted to run because its path is outside the working directory. ` +
            `Do not retry this call. Stay inside the working directory, or tell the user to allow outside access for this run.`,
        };
      }
      const answer = await args.approvalPrompt(args.subject, args.input, args.signal);
      args.consent.current = reduceConsent(
        args.consent.current,
        answer === "no" ? { type: "declined" } : { type: "granted" },
      );
      if (answer === "no") {
        return {
          kind: "deny-declined",
          reason:
            `Tool "${args.subject}" was not permitted to run because its path is outside the working directory. ` +
            `Do not retry this call. Stay inside the working directory, or tell the user to allow outside access for this run.`,
        };
      }
      return { kind: "allow" };
    }
  }
  const byMode = (kind: "deny-blocked" | "deny-declined"): PermissionVerdict => ({
    kind,
    reason:
      `Tool "${args.subject}" was not permitted to run (permission mode: ${args.mode}). ` +
      `Do not retry this call. Either use a tool that does not write, or tell the user to run ` +
      `/mode to change the permission mode.`,
  });
  const permission = checkPermission(args.subject, args.mode, args.allowedTools, {
    input: args.input,
    denials: args.denials,
    cwd: args.cwd,
  });
  if (permission === "allow") {
    if (
      args.mode === "auto" &&
      classifyBuiltin(args.toolName) !== "read" &&
      !args.allowedTools.has(args.subject)
    ) {
      const classified = args.classifyToolCall?.(args.subject, args.input) ?? { kind: "allow" };
      if (classified.kind === "block") {
        const reason =
          `Tool "${args.subject}" was blocked by the auto-mode classifier: ${classified.reason} ` +
          `Do not retry this call.`;
        if (args.autoModeOnBlock === "ask" && args.approvalPrompt !== undefined) {
          const answer = await args.approvalPrompt(args.subject, args.input, args.signal, {
            classifierReason: classified.reason,
          });
          if (answer === "always") {
            args.allowedTools.add(args.subject);
            return { kind: "allow-new" };
          }
          if (answer === "no") return { kind: "deny-declined", reason };
          return { kind: "allow" };
        }
        return { kind: "deny-blocked", reason };
      }
    }
    return { kind: "allow" };
  }
  if (permission === "block") {
    if (denialBlocks(args.denials, args.subject, args.input, args.cwd)) {
      return {
        kind: "deny-blocked",
        reason:
          `Tool "${args.subject}" was not permitted to run because the path matched a deny rule. ` +
          `Do not retry this call, including with another read tool on the same path.`,
      };
    }
    return byMode("deny-blocked");
  }
  if (args.approvalPrompt === undefined) return byMode("deny-blocked");
  const answer = await args.approvalPrompt(args.subject, args.input, args.signal);
  if (answer === "always") {
    args.allowedTools.add(args.subject);
    return { kind: "allow-new" };
  }
  return answer === "no" ? byMode("deny-declined") : { kind: "allow" };
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
  /** The name shown at the gate, approval prompt, and events; a composite tool may carry a different subject in its input. */
  callSubject?: (toolName: string, input: unknown) => string;
  /** Called after executed tools resolve; returned text is appended as a user message, undefined appends nothing. */
  onToolPhaseEnd?: (
    executed: readonly { toolName: string; input: unknown }[],
  ) => string | undefined;
  /** Runs after path deny and before the rest of the gate; `block` stops the call, `errors` are reported and the call continues. */
  onBeforeTool?: (
    subject: string,
    input: unknown,
  ) => Promise<{ readonly block?: string; readonly errors?: readonly string[] }>;
  /** Runs after the tool result is recorded; returned strings are `error` events and cannot veto the call. */
  onAfterTool?: (subject: string, input: unknown, result: unknown) => Promise<readonly string[]>;
  containmentEscapeExpected?: boolean;
  allowedTools?: readonly string[];
  workingDirectory?: string;
  blockReadsOutsideWorkingDirectories?: boolean;
  askOutsideFs?: boolean;
  outsideConsent?: { current: Consent };
  maxIterations?: number;
  system?: string;
  contextWindowSize?: number;
  compactionThreshold?: number;
  preserveRecentTokens?: number;
  signal?: AbortSignal;
  provider?: ModelProvider;
  modelId?: string;
  catalog?: ModelCatalog;
  credential?: RouteCredential;
  reasoningEffort?: string;
  temperature?: number;
  seed?: number;
  terminalTools?: ReadonlySet<string>;
  pathDenials?: readonly PathDenial[];
  cwd?: string;
  classifyToolCall?: ToolCallClassifier;
  autoModeOnBlock?: AutoModeOnBlock;
}): AsyncGenerator<LoopEvent> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const catalogEntry =
    opts.catalog && opts.provider && opts.modelId
      ? findCatalogEntry(opts.catalog, opts.modelId, opts.provider)
      : undefined;
  const contextWindowSize =
    opts.contextWindowSize ?? catalogEntry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW_SIZE;
  const legalReasoningEffort = appliedReasoningEffort(opts.reasoningEffort, catalogEntry);
  const sampling = resolveSampling(opts.provider, opts.credential, {
    temperature: opts.temperature,
    seed: opts.seed,
  });
  const samplingFields = samplingCallFields(sampling);
  const compactionThreshold = opts.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const preserveRecentTokens = opts.preserveRecentTokens ?? DEFAULT_PRESERVE_RECENT_TOKENS;
  const messages: ModelMessage[] = [...opts.messages];
  let estimatedTokens = estimateTokens(messages);
  function appendMessage(message: ModelMessage): void {
    messages.push(message);
    estimatedTokens += estimateTokens(message);
  }
  const turnUserText = lastUserText(opts.messages);

  // ai auto-runs a tool `execute` during streamText; strip it so the gate runs first.
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
      estimatedTokens = estimateTokens(messages);
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
  const allowedTools = new Set<string>(opts.allowedTools ?? []);
  const fsConsent = opts.outsideConsent ?? { current: "unasked" as Consent };
  let consecutiveDenials = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (opts.signal?.aborted) {
      yield { type: "done", reason: "aborted" };
      return;
    }

    const tokens = Math.max(lastInputTokens, estimatedTokens);
    if (tokens / contextWindowSize >= compactionThreshold) {
      const thresholdOutcome = yield* tryCompact("soft");
      if (thresholdOutcome === "aborted") return;
    }

    let text = "";
    const toolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [];
    let overflowRetried = false;

    // ai@7.0.48 streamText notifies onLanguageModelCallStart from inside the retry wrapper, with no onRetry and neither error nor delay.
    let modelCallStarts = 0;
    let reportedRetries = 0;

    const providerOptions =
      legalReasoningEffort && opts.provider
        ? buildReasoningProviderOptions(opts.provider, legalReasoningEffort)
        : undefined;

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
          // ai@7.0.48 defaults onError to console.error of the raw APICallError (body, headers, stack).
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
            // ai types result.usage as PromiseLike (no .catch); when doStream rejects with retries exhausted it rejects with AI_NoOutputGeneratedError.
            const failedUsage = await Promise.resolve(result.usage).catch(() => undefined);
            if (failedUsage !== undefined) {
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
        let cost: CostReport | undefined;
        let servedProvider: string | undefined;
        if (opts.credential === "subscription") {
          cost = reportForSubscription();
        } else if (opts.provider === "openrouter") {
          const providerMetadata = await Promise.resolve(result.providerMetadata).catch(
            () => undefined,
          );
          cost = reportForOpenRouter(resultUsage, providerMetadata);
          servedProvider = openRouterServedProvider(providerMetadata);
        } else if (opts.provider && opts.modelId && opts.catalog) {
          cost = reportFromCatalogPricing(opts.modelId, opts.provider, resultUsage, opts.catalog);
        }
        yield {
          type: "usage",
          usage: resultUsage,
          cost,
          ...(servedProvider !== undefined ? { servedProvider } : {}),
        };
      } catch (err) {
        // On cancel, ai@7.0.48 fullStream yields `abort` and closes; `await result.usage` rejects with AbortError.
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
        appendMessage({ role: "assistant", content: [{ type: "text", text }] });
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
    appendMessage({ role: "assistant", content: assistantContent });
    yield { type: "messages-updated", messages: [...messages] };

    const toolResults: ToolContent = [];
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
      if (opts.signal?.aborted) break;

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

      const subject = opts.callSubject?.(call.toolName, call.input) ?? call.toolName;
      const pathDenied = denialBlocks(opts.pathDenials, subject, call.input, opts.cwd);

      if (pathDenied) {
        if ((yield* flushReadBatch()) === "aborted") break;
        yield { type: "permission-denied", name: subject, reason: "blocked" };
        toolResults.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: {
            type: "execution-denied",
            reason:
              `Tool "${subject}" was not permitted to run because the path matched a deny rule. ` +
              `Do not retry this call, including with another read tool on the same path.`,
          },
        });
        continue;
      }

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
          if (opts.signal?.aborted) break;
          throw err;
        }
        if ((hook.errors?.length ?? 0) > 0 && (yield* flushReadBatch()) === "aborted") break;
        for (const error of hook.errors ?? []) yield { type: "error", error };
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

      const verdict = await decidePermission({
        subject,
        toolName: call.toolName,
        input: call.input,
        mode: opts.permissionMode,
        allowedTools,
        approvalPrompt: opts.approvalPrompt,
        signal: opts.signal,
        denials: opts.pathDenials,
        cwd: opts.cwd,
        turnUserText,
        workingDirectory: opts.workingDirectory,
        standingDeny: opts.blockReadsOutsideWorkingDirectories === true,
        askOutsideFs: opts.askOutsideFs === true,
        consent: fsConsent,
        classifyToolCall: opts.classifyToolCall,
        autoModeOnBlock: opts.autoModeOnBlock ?? "deny",
      });

      if (opts.signal?.aborted) break;

      if (verdict.kind === "allow-new") yield { type: "tool-allowed", name: subject };

      if (verdict.kind === "deny-blocked" || verdict.kind === "deny-declined") {
        if ((yield* flushReadBatch()) === "aborted") break;
        if (verdict.kind === "deny-declined") consecutiveDenials++;
        yield {
          type: "permission-denied",
          name: subject,
          reason: verdict.kind === "deny-blocked" ? "blocked" : "declined",
        };
        toolResults.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "execution-denied", reason: verdict.reason },
        });
        continue;
      }

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

      if (opts.onAfterTool !== undefined) {
        let afterMessages: readonly string[];
        try {
          afterMessages = await opts.onAfterTool(subject, call.input, toolResult);
        } catch (err) {
          if (opts.signal?.aborted) break;
          throw err;
        }
        for (const error of afterMessages) yield { type: "error", error };
      }
    }

    yield* flushReadBatch();

    const answeredIds = new Set(
      toolResults.flatMap((row) => ("toolCallId" in row ? [row.toolCallId] : [])),
    );
    const unanswered = toolCalls.filter((call) => !answeredIds.has(call.toolCallId));

    // ai throws AI_MissingToolResultsError on resume if a persisted assistant tool-call has no matching tool-result row.
    for (const call of unanswered) {
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

    appendMessage({ role: "tool", content: toolResults });
    yield { type: "messages-updated", messages: [...messages] };

    if (unanswered.length > 0) {
      yield { type: "done", reason: "aborted" };
      return;
    }

    if (terminalHit) {
      yield { type: "done", reason: "plan-submitted" };
      return;
    }

    if (consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
      yield { type: "done", reason: "repeated-denials" };
      return;
    }

    const appended = executed.length === 0 ? undefined : opts.onToolPhaseEnd?.(executed);
    if (appended !== undefined && appended.length > 0) {
      appendMessage({ role: "user", content: [{ type: "text", text: appended }] });
      yield { type: "messages-updated", messages: [...messages] };
    }
  }

  yield { type: "done", reason: "max-iterations" };
}
