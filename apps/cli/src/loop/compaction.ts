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
    for (const message of input as readonly ModelMessage[]) total += estimateMessageTokens(message);
    return total;
  }
  return estimateMessageTokens(input as ModelMessage);
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

// ai@7.0.48 defaults maxRetries to 2 with a 2s first backoff and honours a shorter retry-after / retry-after-ms header.
export const MAX_RETRIES = 2;

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

// ai errors (AI_MissingToolResultsError) if a `role:"tool"` message is kept without its adjacent assistant tool-call.
const OVERFLOW_MARKERS = ["too many tokens", "maximum context", "context_length", "token limit"];

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
  if (
    /\bcontext\b/.test(text) &&
    /window|length|exceed|limit|too (?:long|large)|overflow/.test(text)
  ) {
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

const COMPACT_HISTORY_PREFIX = "[Compacted history —";

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return "";
}

function isCompactSummaryMessage(message: ModelMessage | undefined): boolean {
  return message?.role === "user" && messageText(message).startsWith(COMPACT_HISTORY_PREFIX);
}

function toolCallPath(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

export function extractFileLists(evicted: readonly ModelMessage[]): {
  read: string[];
  modified: string[];
} {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const message of evicted) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object" || (part as { type?: string }).type !== "tool-call") {
        continue;
      }
      const call = part as { toolName?: string; input?: unknown };
      const path = toolCallPath(call.input);
      if (path === undefined) continue;
      if (call.toolName === "read_file") read.add(path);
      else if (call.toolName === "write_file" || call.toolName === "edit") modified.add(path);
    }
  }
  for (const path of modified) read.delete(path);
  return { read: [...read], modified: [...modified] };
}

function formatFileListLines(lists: { read: string[]; modified: string[] }): string {
  const lines: string[] = [];
  if (lists.read.length > 0) lines.push(`Read: ${lists.read.join(", ")}`);
  if (lists.modified.length > 0) lines.push(`Modified: ${lists.modified.join(", ")}`);
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

function buildSummarizerPrompt(
  evicted: ModelMessage[],
  customInstructions?: string,
): { system: string; prompt: string } {
  const previous = isCompactSummaryMessage(evicted[0]) ? evicted[0] : undefined;
  const transcript = JSON.stringify(elideOversizedStrings(evicted));
  const focus =
    customInstructions && customInstructions.length > 0
      ? `\n\nAdditional focus: ${customInstructions}`
      : "";

  if (previous) {
    return {
      system:
        'You are updating a compact recap of an in-progress coding agent session. PRESERVE specific concrete literals (filenames, paths, numbers, identifiers, secrets, URLs) verbatim. Promote completed work from nextSteps into progress. Drop stale blockers that the new turns resolved. Oversized strings are replaced with {"elided":true,"originalBytes":N}; do not invent contents of elided payloads. Losing a remaining literal is a real failure; a slightly longer summary is not.',
      prompt: `Update this previous recap with the newly evicted turns. PRESERVE literals from the previous four fields. Promote finished work into progress. Drop stale blockers.\n\nPrevious recap:\n${messageText(previous)}\n\nNewly evicted turns:\n${transcript}\n\nRespond with ONLY a JSON object with exactly the four string fields goal, progress, blockers, nextSteps — no markdown code fences, no explanation before or after.${focus}`,
    };
  }

  return {
    system:
      'You are summarizing the older portion of an in-progress coding agent session so it can be replaced with a compact recap. Where the transcript still contains specific concrete data — filenames, paths, numbers, identifiers, secrets, URLs, or other short literals — quote them verbatim in the relevant field rather than paraphrasing. Oversized strings are replaced with {"elided":true,"originalBytes":N}; those were raw tool payloads and must not be reconstructed. Losing a remaining literal is a real failure; a slightly longer summary is not.',
    prompt: `Summarize this JSON-encoded transcript of earlier conversation turns into a structured recap with four fields: goal, progress, blockers, nextSteps.\n\nFor the progress field in particular: if any concrete artifacts or discoveries appear in the transcript (e.g. a path written to, a short value returned by a command, a specific name or number), quote them verbatim rather than just describing the action taken. Do not invent contents of elided payloads.\n\nRespond with ONLY a JSON object with exactly those four string fields — no markdown code fences, no explanation before or after.\n\nTranscript:\n${transcript}${focus}`,
  };
}

export async function compactMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  evictBoundary: number,
  signal?: AbortSignal,
  opts?: { stream?: boolean; customInstructions?: string; temperature?: number; seed?: number },
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

  // generateText fires onLanguageModelCallStart once per step before its retry wrapper (ai@7.0.48); wrapGenerate is the only retry counter. ChatGPT-plan Responses rejects generateText unless stream is true.
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

  const { system, prompt } = buildSummarizerPrompt(evicted, opts?.customInstructions);

  let text: string;
  let usage: LanguageModelUsage;
  const sampling = {
    ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
  };
  if (opts?.stream) {
    const result = streamText({
      model: countedModel,
      abortSignal: signal,
      maxRetries: MAX_RETRIES,
      system,
      prompt,
      ...sampling,
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
      ...sampling,
    });
    text = generated.text;
    usage = generated.usage;
  }
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  const summary = CompactionSummarySchema.parse(JSON.parse(stripped));

  const fileLists = extractFileLists(evicted);
  const summaryMessage: ModelMessage = {
    role: "user",
    content:
      `[Compacted history — ${evictBoundary} earlier messages condensed]\n` +
      `Goal: ${summary.goal}\n` +
      `Progress: ${summary.progress}\n` +
      `Blockers: ${summary.blockers}\n` +
      `Next steps: ${summary.nextSteps}` +
      formatFileListLines(fileLists),
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
