import { generateText, streamText, wrapLanguageModel } from "ai";
import type { LanguageModel, LanguageModelUsage, ModelMessage } from "ai";
import { z } from "zod";

export const CompactionSummarySchema = z.object({
  goal: z.string(),
  progress: z.string(),
  blockers: z.string(),
  nextSteps: z.string(),
});

export type CompactionSummary = z.infer<typeof CompactionSummarySchema>;

const DEFAULT_MIN_EVICTABLE = 4;

export const DEFAULT_PRESERVE_RECENT_TOKENS = 20_000;

export function estimateTokens(message: ModelMessage): number;
export function estimateTokens(messages: readonly ModelMessage[]): number;
export function estimateTokens(input: ModelMessage | readonly ModelMessage[]): number {
  if (Array.isArray(input)) {
    let total = 0;
    for (const message of input) total += estimateMessageTokens(message);
    return total;
  }
  return estimateMessageTokens(input);
}

function estimateMessageTokens(message: ModelMessage): number {
  const content = message.content;
  if (typeof content === "string") return charsToTokens(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) total += estimatePartTokens(part);
  return total;
}

function charsToTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimatePartTokens(part: unknown): number {
  if (typeof part === "string") return charsToTokens(part);
  if (part === null || typeof part !== "object") return 0;
  const record = part as Record<string, unknown>;
  if (record.type === "tool-call") {
    return charsToTokens(JSON.stringify(record.input ?? record.args ?? {}));
  }
  if (record.type === "tool-result") {
    return charsToTokens(JSON.stringify(record.output ?? record.result ?? {}));
  }
  if (typeof record.text === "string") return charsToTokens(record.text);
  if (typeof record.thinking === "string") return charsToTokens(record.thinking);
  return 0;
}

// Deliberately the same 2 the SDK already applies when nothing passes it (ai@7.0.48
// dist/index.js:2789), so this changes no behaviour: every streamText and generateText call in
// this repo has been retrying a 429 or a 5xx twice, with a 2 s first backoff, before the failure
// ever reached the user. Stated here because a spend question ("why three calls for one turn?")
// cannot be answered from a default that no line of this repo mentions. The delay is the SDK's and
// is not configurable through streamText: it honours a `retry-after-ms`/`retry-after` response
// header when that is shorter than its own backoff (dist/index.js:2718).
//
// It lives in this module, which is the lower of the two — loop.ts already imports compaction.ts,
// so the import goes the way that exists and no cycle is created. One constant rather than two
// equal literals in two files: what the number means is "the SDK's default, restated", and two
// copies of that can drift into disagreeing about a shared claim.
export const MAX_RETRIES = 2;

// Per-string cap for the summarizer prompt only. Identifiers, paths, and short command
// output fit; file bodies and write_file content do not. The session still evicts the raw
// messages; this stops the extra model call from ingesting them. Clone-on-walk, never
// mutate the caller's transcript.
export const SUMMARIZER_STRING_CAP_BYTES = 2048;

export function elideOversizedStrings(
  value: unknown,
  capBytes = SUMMARIZER_STRING_CAP_BYTES,
): unknown {
  if (typeof value === "string") {
    const originalBytes = Buffer.byteLength(value, "utf8");
    if (originalBytes <= capBytes) return value;
    return { elided: true, originalBytes };
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => elideOversizedStrings(item, capBytes));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = elideOversizedStrings(child, capBytes);
  }
  return out;
}

// A cut is only safe immediately before a "user"/"assistant" message, never before a
// "tool" message — a `role:"tool"` message is always the second half of an adjacent
// {assistant tool-call, tool result} pair pushed by loop.ts, and evicting one half while
// keeping the other reproduces the AI_MissingToolResultsError class of bug (fixed in
// 24c2aa1).
const OVERFLOW_MARKERS = [
  "too many tokens",
  "maximum context",
  "context_length",
  "token limit",
];

function errorSearchText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === "object" && "message" in current) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string") parts.push(message);
    }
    break;
  }
  return parts.join(" ").toLowerCase();
}

function statusCodeOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "statusCode" in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    if (typeof code === "number") return code;
  }
  return undefined;
}

export function isContextOverflowError(err: unknown): boolean {
  const text = errorSearchText(err);
  if (OVERFLOW_MARKERS.some((marker) => text.includes(marker))) return true;
  if (/\bcontext\b/.test(text) && /window|length|exceed|limit|too (?:long|large)|overflow/.test(text)) {
    return true;
  }
  return statusCodeOf(err) === 400 && /\bcontext\b/.test(text);
}

export function findSafeEvictionBoundary(
  messages: ModelMessage[],
  keepRecentTokens: number,
  minEvictable = DEFAULT_MIN_EVICTABLE,
): number | null {
  let kept = 0;
  let boundary = messages.length;
  while (boundary > 0 && kept < keepRecentTokens) {
    boundary--;
    kept += estimateTokens(messages[boundary]!);
  }
  while (boundary > 0 && messages[boundary]?.role === "tool") {
    boundary++;
  }
  if (boundary < minEvictable) return null;
  return boundary;
}

export async function compactMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  evictBoundary: number,
  signal?: AbortSignal,
  opts?: { stream?: boolean },
): Promise<{
  messages: ModelMessage[];
  summary: CompactionSummary;
  evictedCount: number;
  usage: LanguageModelUsage;
  retries: number;
  tokensBefore: number;
}> {
  const tokensBefore = estimateTokens(messages);
  const evicted = messages.slice(0, evictBoundary);

  // Counted through a middleware, not through onLanguageModelCallStart the way loop.ts counts the
  // main call's retries: generateText notifies that callback ONCE per step, before it enters the
  // retry wrapper (ai@7.0.48 dist/index.js:5599, with the `retry(...)` at 5607), where streamText
  // notifies from inside it. Measured with a doGenerate that 429s once then succeeds: two
  // doGenerate calls, one callback notification, two wrapGenerate invocations — the retry wrapper
  // re-invokes the model, so the wrapper around the model is the only place an attempt is visible.
  // Returned rather than printed, and rather than taking a callback, because this module does no
  // I/O and its caller is a generator that cannot yield from a callback: the count travels out the
  // same way `usage` already does. A compaction that exhausts its retries throws instead of
  // returning, so those attempts are not reported — that path reports the error itself.
  //
  // A string `model` is a model id the SDK resolves through its own registry and there is nothing
  // to wrap; nothing in this repo passes one (cli.ts hands over getGroqModel's instance), so it
  // reports no retries rather than growing a resolver for a caller that does not exist.
  //
  // `opts.stream` is required on the ChatGPT-plan Responses host, which rejects generateText with
  // "Stream must be set to true". Other providers keep generateText so existing mocks keep working.
  let attempts = 0;
  const countedModel =
    typeof model === "string"
      ? model
      : wrapLanguageModel({
          model,
          middleware: opts?.stream
            ? {
                wrapStream: async ({ doStream }) => {
                  attempts++;
                  return await doStream();
                },
              }
            : {
                wrapGenerate: async ({ doGenerate }) => {
                  attempts++;
                  return await doGenerate();
                },
              },
        });

  const system =
    'You are summarizing the older portion of an in-progress coding agent session so it can be replaced with a compact recap. Where the transcript still contains specific concrete data — filenames, paths, numbers, identifiers, secrets, URLs, or other short literals — quote them verbatim in the relevant field rather than paraphrasing. Oversized strings are replaced with {"elided":true,"originalBytes":N}; those were raw tool payloads and must not be reconstructed. Losing a remaining literal is a real failure; a slightly longer summary is not.';
  const prompt = `Summarize this JSON-encoded transcript of earlier conversation turns into a structured recap with four fields: goal, progress, blockers, nextSteps.\n\nFor the progress field in particular: if any concrete artifacts or discoveries appear in the transcript (e.g. a path written to, a short value returned by a command, a specific name or number), quote them verbatim rather than just describing the action taken. Do not invent contents of elided payloads.\n\nRespond with ONLY a JSON object with exactly those four string fields — no markdown code fences, no explanation before or after.\n\nTranscript:\n${JSON.stringify(elideOversizedStrings(evicted))}`;

  // Summarizing is a full model round-trip that can run for seconds. Leaving it un-abortable
  // would make "Ctrl-C cancels the turn" conditionally false in a way the user cannot predict:
  // the same keypress would do nothing at all if it landed here.
  let text: string;
  let usage: LanguageModelUsage;
  if (opts?.stream) {
    const result = streamText({
      model: countedModel,
      abortSignal: signal,
      maxRetries: MAX_RETRIES,
      system,
      prompt,
    });
    text = await result.text;
    usage = await result.usage;
  } else {
    const generated = await generateText({
      model: countedModel,
      abortSignal: signal,
      maxRetries: MAX_RETRIES,
      system,
      prompt,
    });
    text = generated.text;
    usage = generated.usage;
  }
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  const summary = CompactionSummarySchema.parse(JSON.parse(stripped));

  const summaryMessage: ModelMessage = {
    role: "user",
    content: `[Compacted history — ${evictBoundary} earlier messages condensed]\nGoal: ${summary.goal}\nProgress: ${summary.progress}\nBlockers: ${summary.blockers}\nNext steps: ${summary.nextSteps}`,
  };

  return {
    messages: [summaryMessage, ...messages.slice(evictBoundary)],
    summary,
    evictedCount: evictBoundary,
    usage,
    retries: Math.max(attempts - 1, 0),
    tokensBefore,
  };
}
