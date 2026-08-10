import { expect, test } from "bun:test";
import { streamText } from "ai";
import { buildSystemPrompt } from "../../src/agents/systemPrompt";
import { getGroqModel } from "../../src/provider/groq";

const MODEL_ID = "openai/gpt-oss-120b";
// Padding, not prose: only needs to push the prefix comfortably past Groq's documented
// (per-model-unpublished) 128-1024 token minimum. ~6000 chars is ~1500 tokens at a
// conservative ~4 chars/token, safely above the top of that documented range.
const PADDING = "The quick brown fox jumps over the lazy dog. ".repeat(150);

test.skipIf(!process.env.GROQ_API_KEY || process.env.SERI_LIVE_CACHE_CHECK !== "1")(
  "a second turn sharing the stable+context prefix gets served from Groq's prompt cache",
  async () => {
    // Per-run nonce at the very head of the prefix: proves turn 1 can't be a hit left warm by
    // an earlier run (this repo's own negative-control rule — .claude/rules/code-quality.md,
    // "An acceptance check must be seen to fail before it counts as passing").
    const nonce = crypto.randomUUID();
    const system = `${nonce}\n\n${buildSystemPrompt(PADDING)}`;
    const model = getGroqModel(MODEL_ID);
    const messages = [{ role: "user" as const, content: "Reply with a single word: OK." }];

    async function runTurn() {
      const result = streamText({ model, system, messages, maxOutputTokens: 16 });
      for await (const _part of result.fullStream) {
        // drain — usage resolves only once the stream is fully consumed (see loop.ts:328-379
        // for the production code following the identical pattern)
      }
      return result.usage;
    }

    const usage1 = await runTurn();
    const usage2 = await runTurn();

    expect(usage1.inputTokenDetails?.cacheReadTokens ?? 0).toBe(0);
    // Asserted separately from the >0 check below: a bare `?? 0` can't tell "Groq reported a
    // real miss" from "Groq's response has no cache field at all" (the latter is what actually
    // happened live, 2026-08-10 — see PROMPT-CACHING-VERIFICATION.md) — this makes that
    // distinction show up in the failure message instead of costing a fresh debug session.
    expect(usage2.inputTokenDetails?.cacheReadTokens).toBeDefined();
    expect(usage2.inputTokenDetails?.cacheReadTokens).toBeGreaterThan(0);
  },
  30000,
);
