import { expect, test } from "bun:test";
import { streamText } from "ai";
import { getAnthropicModel } from "../../src/provider/anthropic";
import { getGoogleModel } from "../../src/provider/google";
import { getOpenAIModel } from "../../src/provider/openai";
import { validateProviderKey } from "../../src/provider/validate";

// Opt-in, skip-by-default (mirrors openrouterCaching.live.test.ts's exact shape): a documented,
// reproducible manual check that BYOK actually authenticates against each native provider,
// direct CLI-to-provider — not run in CI or by a plain `bun test`, since it needs a real key.
async function assertRoundTrip(model: ReturnType<typeof getAnthropicModel>): Promise<void> {
  const result = streamText({
    model,
    messages: [{ role: "user", content: "Reply with a single word: OK." }],
    maxOutputTokens: 16,
  });
  for await (const _part of result.fullStream) {
    // drain — text/usage resolve only once the stream is fully consumed, same pattern as
    // promptCaching.live.test.ts's own runTurn.
  }
  const text = await result.text;
  const usage = await result.usage;
  expect(text.length).toBeGreaterThan(0);
  expect(usage.inputTokens ?? 0).toBeGreaterThan(0);
}

test.skipIf(!process.env.ANTHROPIC_API_KEY || process.env.SERI_LIVE_PROVIDER_CHECK !== "1")(
  "getAnthropicModel round-trips a real turn against the Anthropic API",
  async () => {
    await assertRoundTrip(getAnthropicModel("claude-haiku-4-5"));
  },
  30000,
);

test.skipIf(!process.env.OPENAI_API_KEY || process.env.SERI_LIVE_PROVIDER_CHECK !== "1")(
  "getOpenAIModel round-trips a real turn against the OpenAI API",
  async () => {
    await assertRoundTrip(getOpenAIModel("gpt-4.1-mini"));
  },
  30000,
);

test.skipIf(
  !process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.SERI_LIVE_PROVIDER_CHECK !== "1",
)(
  "getGoogleModel round-trips a real turn against the Google API",
  async () => {
    await assertRoundTrip(getGoogleModel("gemini-2.5-flash"));
  },
  30000,
);

// D5's own probe (apps/cli/src/provider/validate.ts), extended to all five providers per
// feature-plan.md's Test plan — the only place validateProviderKey is ever exercised against a
// real endpoint. Same opt-in shape as the round-trips above: skipped unless
// SERI_LIVE_PROVIDER_CHECK=1 AND the provider's own real key are both present, so a plain
// `bun test` never touches the network.
test.skipIf(!process.env.GROQ_API_KEY || process.env.SERI_LIVE_PROVIDER_CHECK !== "1")(
  "validateProviderKey round-trips a real probe against the Groq API",
  async () => {
    const result = await validateProviderKey("groq", process.env.GROQ_API_KEY ?? "");
    expect(result).toEqual({ ok: true, checked: true });
  },
  30000,
);

test.skipIf(!process.env.OPENROUTER_API_KEY || process.env.SERI_LIVE_PROVIDER_CHECK !== "1")(
  "validateProviderKey round-trips a real probe against the OpenRouter API",
  async () => {
    const result = await validateProviderKey("openrouter", process.env.OPENROUTER_API_KEY ?? "");
    expect(result).toEqual({ ok: true, checked: true });
  },
  30000,
);

test.skipIf(!process.env.ANTHROPIC_API_KEY || process.env.SERI_LIVE_PROVIDER_CHECK !== "1")(
  "validateProviderKey round-trips a real probe against the Anthropic API",
  async () => {
    const result = await validateProviderKey("anthropic", process.env.ANTHROPIC_API_KEY ?? "");
    expect(result).toEqual({ ok: true, checked: true });
  },
  30000,
);

test.skipIf(!process.env.OPENAI_API_KEY || process.env.SERI_LIVE_PROVIDER_CHECK !== "1")(
  "validateProviderKey round-trips a real probe against the OpenAI API",
  async () => {
    const result = await validateProviderKey("openai", process.env.OPENAI_API_KEY ?? "");
    expect(result).toEqual({ ok: true, checked: true });
  },
  30000,
);

test.skipIf(
  !process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.SERI_LIVE_PROVIDER_CHECK !== "1",
)(
  "validateProviderKey round-trips a real probe against the Google API",
  async () => {
    const result = await validateProviderKey(
      "google",
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
    );
    expect(result).toEqual({ ok: true, checked: true });
  },
  30000,
);
