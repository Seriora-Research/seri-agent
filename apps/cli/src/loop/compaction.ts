import { generateText, wrapLanguageModel } from "ai";
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
): Promise<{
  messages: ModelMessage[];
  summary: CompactionSummary;
  evictedCount: number;
  usage: LanguageModelUsage;
  retries: number;
}> {
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
  let attempts = 0;
  const countedModel =
    typeof model === "string"
      ? model
      : wrapLanguageModel({
          model,
          middleware: {
            wrapGenerate: async ({ doGenerate }) => {
              attempts++;
              return await doGenerate();
            },
          },
        });

  // Summarizing is a full model round-trip that can run for seconds. Leaving it un-abortable
  // would make "Ctrl-C cancels the turn" conditionally false in a way the user cannot predict:
  // the same keypress would do nothing at all if it landed here.
  const { text, usage } = await generateText({
    model: countedModel,
    abortSignal: signal,
    // Stated rather than defaulted: this round-trip can cost three model calls, and nothing said so.
    maxRetries: MAX_RETRIES,
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
    retries: Math.max(attempts - 1, 0),
  };
}
