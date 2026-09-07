import { expect, test } from "bun:test";
import { streamText } from "ai";
import { buildSystemPrompt } from "../../src/agents/systemPrompt";
import { getOpenRouterModel } from "../../src/provider/openrouter";

const MODEL_ID = "openai/gpt-4o-mini";
// ~6000 chars is past OpenRouter's cacheable-prompt minimum.
const PADDING = "The quick brown fox jumps over the lazy dog. ".repeat(150);

type OpenRouterProviderMetadata = {
  openrouter?: { usage?: { promptTokensDetails?: { cachedTokens?: number } } };
};

test.skipIf(!process.env.OPENROUTER_API_KEY || process.env.SERI_LIVE_CACHE_CHECK !== "1")(
  "a second turn sharing the stable+context prefix, with session_id sticky routing, gets served from OpenRouter's prompt cache",
  async () => {
    const nonce = crypto.randomUUID();
    const system = `${nonce}\n\n${buildSystemPrompt({ agentsContent: PADDING, skills: [], rules: [] })}`;

    const sessionId = crypto.randomUUID();
    const model = getOpenRouterModel(MODEL_ID, sessionId);
    const messages = [{ role: "user" as const, content: "Reply with a single word: OK." }];

    async function runTurn() {
      const result = streamText({ model, system, messages, maxOutputTokens: 16 });
      for await (const _part of result.fullStream) {
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

    expect(cachedTokens2).toBeDefined();
    expect(cachedTokens2).toBeGreaterThan(0);
  },
  30000,
);
