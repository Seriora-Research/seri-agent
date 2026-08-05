import { generateText } from "ai";
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

// A cut is only safe immediately before a "user"/"assistant" message, never before a
// "tool" message — a `role:"tool"` message is always the second half of an adjacent
// {assistant tool-call, tool result} pair pushed by loop.ts, and evicting one half while
// keeping the other reproduces the AI_MissingToolResultsError class of bug (fixed in
// 24c2aa1).
export function findSafeEvictionBoundary(
  messages: ModelMessage[],
  preserveRecentMessages: number,
  minEvictable = DEFAULT_MIN_EVICTABLE,
): number | null {
  let boundary = messages.length - preserveRecentMessages;
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
): Promise<{ messages: ModelMessage[]; summary: CompactionSummary; evictedCount: number; usage: LanguageModelUsage }> {
  const evicted = messages.slice(0, evictBoundary);
  // Summarizing is a full model round-trip that can run for seconds. Leaving it un-abortable
  // would make "Ctrl-C cancels the turn" conditionally false in a way the user cannot predict:
  // the same keypress would do nothing at all if it landed here.
  const { text, usage } = await generateText({
    model,
    abortSignal: signal,
    system:
      "You are summarizing the older portion of an in-progress coding agent session so it can be replaced with a compact recap. Where the transcript contains specific concrete data — exact file contents, literal strings, filenames, paths, numbers, identifiers, secrets, URLs, or any other specific values — quote them verbatim in the relevant field rather than paraphrasing or describing them generically. Losing a literal value is a real failure; a slightly longer summary is not.",
    prompt: `Summarize this JSON-encoded transcript of earlier conversation turns into a structured recap with four fields: goal, progress, blockers, nextSteps.\n\nFor the progress field in particular: if any concrete artifacts or discoveries appear in the transcript (e.g. text written to a file, a value returned by a command, a specific name or number), quote them verbatim rather than just describing the action taken.\n\nRespond with ONLY a JSON object with exactly those four string fields — no markdown code fences, no explanation before or after.\n\nTranscript:\n${JSON.stringify(evicted)}`,
  });
  const stripped = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
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
  };
}
