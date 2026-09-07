import { expect, test } from "bun:test";
import { streamText } from "ai";
import { buildSystemPrompt } from "../../src/agents/systemPrompt";
import { getGroqModel } from "../../src/provider/groq";

const MODEL_ID = "openai/gpt-oss-120b";
// ~6000 chars is past Groq's 128-1024 token cache minimum.
const PADDING = "The quick brown fox jumps over the lazy dog. ".repeat(150);

test.skipIf(!process.env.GROQ_API_KEY || process.env.SERI_LIVE_CACHE_CHECK !== "1")(
  "a second turn sharing the stable+context prefix gets served from Groq's prompt cache",
  async () => {
    const nonce = crypto.randomUUID();
    const system = `${nonce}\n\n${buildSystemPrompt({ agentsContent: PADDING, skills: [], rules: [] })}`;
    const model = getGroqModel(MODEL_ID);
    const messages = [{ role: "user" as const, content: "Reply with a single word: OK." }];

    async function runTurn() {
      const result = streamText({ model, system, messages, maxOutputTokens: 16 });
      for await (const _part of result.fullStream) {
      }
      return result.usage;
    }

    const usage1 = await runTurn();
    const usage2 = await runTurn();

    expect(usage1.inputTokenDetails?.cacheReadTokens ?? 0).toBe(0);

    expect(usage2.inputTokenDetails?.cacheReadTokens).toBeDefined();
    expect(usage2.inputTokenDetails?.cacheReadTokens).toBeGreaterThan(0);
  },
  30000,
);
