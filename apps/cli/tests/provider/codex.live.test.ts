import { expect, test } from "bun:test";
import { streamText } from "ai";
import { hasCodexSubscription } from "../../src/auth/codexAuthStore";
import { getCodexSubscriptionModel } from "../../src/provider/codex";

test.skipIf(!hasCodexSubscription() || process.env.SERI_LIVE_CODEX_CHECK !== "1")(
  "a Codex subscription streams a turn with store false still enforced",
  async () => {
    const model = getCodexSubscriptionModel("gpt-5.6-terra", process.env.HOME ?? "/tmp");
    const result = streamText({
      model,
      messages: [{ role: "user", content: "Reply with a single word: PONG." }],
      maxOutputTokens: 16,
    });
    for await (const _part of result.fullStream) {
    }
    const text = await result.text;
    const usage = await result.usage;
    expect(text.length).toBeGreaterThan(0);
    expect(usage.inputTokens ?? 0).toBeGreaterThan(0);
  },
  30000,
);
