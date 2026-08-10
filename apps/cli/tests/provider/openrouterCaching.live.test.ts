import { expect, test } from "bun:test";
import { streamText } from "ai";
import { buildSystemPrompt } from "../../src/agents/systemPrompt";
import { getOpenRouterModel } from "../../src/provider/openrouter";

const MODEL_ID = "openai/gpt-4o-mini";
// Padding, not prose: only needs to push the prefix comfortably past OpenRouter's/the underlying
// model's minimum cacheable prompt size. ~6000 chars is ~1500 tokens at a conservative ~4
// chars/token, safely above the top of Groq's own documented 128-1024 token range (this file's
// sibling promptCaching.live.test.ts), and OpenRouter's own live-verified prefix (~1520 tokens,
// OPENROUTER-PROVIDER-PINNING.md) is in the same range.
const PADDING = "The quick brown fox jumps over the lazy dog. ".repeat(150);

// Same asserted-not-inferred shape as cost.ts's own OpenRouterProviderMetadata: the AI SDK's
// ProviderMetadata type only narrows to Record<string, JSONObject>, so this is checked against
// the installed @openrouter/ai-sdk-provider@3.0.0's OpenRouterUsageAccounting type directly.
type OpenRouterProviderMetadata = {
  openrouter?: { usage?: { promptTokensDetails?: { cachedTokens?: number } } };
};

test.skipIf(!process.env.OPENROUTER_API_KEY || process.env.SERI_LIVE_CACHE_CHECK !== "1")(
  "a second turn sharing the stable+context prefix, with session_id sticky routing, gets served from OpenRouter's prompt cache",
  async () => {
    // Per-run nonce at the very head of the prefix: proves turn 1 can't be a hit left warm by
    // an earlier run (this repo's own negative-control rule — .claude/rules/code-quality.md,
    // "An acceptance check must be seen to fail before it counts as passing").
    const nonce = crypto.randomUUID();
    const system = `${nonce}\n\n${buildSystemPrompt(PADDING)}`;
    // A session-scoped UUID minted once, mirroring how cli.ts derives sessionId from session.id
    // for the life of one CLI session — both turns below share it, which is what sticky routing
    // needs.
    const sessionId = crypto.randomUUID();
    const model = getOpenRouterModel(MODEL_ID, sessionId);
    const messages = [{ role: "user" as const, content: "Reply with a single word: OK." }];

    async function runTurn() {
      const result = streamText({ model, system, messages, maxOutputTokens: 16 });
      for await (const _part of result.fullStream) {
        // drain — providerMetadata resolves only once the stream is fully consumed (a Promise on
        // streamText results, see cost.ts's own documented caveat)
      }
      return result.providerMetadata;
    }

    const providerMetadata1 = await runTurn();
    const providerMetadata2 = await runTurn();

    const cachedTokens1 = (providerMetadata1 as OpenRouterProviderMetadata | undefined)?.openrouter
      ?.usage?.promptTokensDetails?.cachedTokens;
    const cachedTokens2 = (providerMetadata2 as OpenRouterProviderMetadata | undefined)?.openrouter
      ?.usage?.promptTokensDetails?.cachedTokens;

    expect(cachedTokens1 ?? 0).toBe(0);
    // Asserted separately from the >0 check below: a bare `?? 0` can't tell "OpenRouter reported
    // a real miss" from "the response has no cache field at all" — see promptCaching.live.test.ts's
    // own identical M3 fix for the reasoning.
    expect(cachedTokens2).toBeDefined();
    expect(cachedTokens2).toBeGreaterThan(0);
  },
  30000,
);
