import { describe, expect, test } from "bun:test";
import type { ModelCatalog } from "@seri/model-catalog";
import type { LanguageModelUsage, ProviderMetadata } from "ai";
import { reportForGroq, reportForOpenRouter } from "../../src/provider/cost";

const usage = (inputTokens: number, outputTokens: number): LanguageModelUsage => ({
  inputTokens,
  inputTokenDetails: {
    noCacheTokens: inputTokens,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  },
  outputTokens,
  outputTokenDetails: { textTokens: outputTokens, reasoningTokens: undefined },
  totalTokens: inputTokens + outputTokens,
});

const fixtureCatalog: ModelCatalog = {
  fetchedAt: "2026-01-01T00:00:00.000Z",
  entries: [
    {
      id: "llama-3.3-70b-versatile",
      provider: "groq",
      displayName: "Llama 3.3 70B Versatile",
      family: "llama",
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
      toolCall: true,
      reasoning: false,
      pricing: { inputPerMTok: 0.59, outputPerMTok: 0.79 },
    },
  ],
};

describe("reportForOpenRouter", () => {
  test("returns actual/provider_cost_api from providerMetadata.openrouter.usage.cost", () => {
    const providerMetadata: ProviderMetadata = {
      openrouter: {
        provider: "openrouter",
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.0031 },
      },
    };

    expect(reportForOpenRouter(usage(100, 50), providerMetadata)).toEqual({
      amountUsd: 0.0031,
      status: "actual",
      source: "provider_cost_api",
    });
  });
});

describe("reportForGroq", () => {
  test("computes cost from the catalog entry's pricing", () => {
    expect(
      reportForGroq("llama-3.3-70b-versatile", usage(1_000_000, 1_000_000), fixtureCatalog),
    ).toEqual({
      amountUsd: 1.38,
      status: "estimated",
      source: "provider_models_api",
    });
  });

  test("returns unknown/none for a model id absent from the catalog", () => {
    expect(reportForGroq("some-unlisted-model", usage(100, 50), fixtureCatalog)).toEqual({
      amountUsd: undefined,
      status: "unknown",
      source: "none",
    });
  });
});
