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
    {
      id: "cached-model",
      provider: "groq",
      displayName: "Cached Model",
      family: "test",
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
      toolCall: true,
      reasoning: false,
      pricing: {
        inputPerMTok: 1.0,
        outputPerMTok: 2.0,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 0.5,
      },
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

  test("returns unknown/none when providerMetadata carries no cost field", () => {
    const providerMetadata: ProviderMetadata = {
      openrouter: {
        provider: "openrouter",
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    };

    expect(reportForOpenRouter(usage(100, 50), providerMetadata)).toEqual({
      amountUsd: undefined,
      status: "unknown",
      source: "none",
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

  // Code-review finding: pricing ALL of usage.inputTokens at the full rate double-bills whatever
  // portion was actually a cache read/write.
  test("prices cache-read and cache-write tokens at the catalog's cache rates, not the full rate", () => {
    const cachedUsage: LanguageModelUsage = {
      inputTokens: 1_000_000,
      inputTokenDetails: {
        noCacheTokens: 600_000,
        cacheReadTokens: 300_000,
        cacheWriteTokens: 100_000,
      },
      outputTokens: 0,
      outputTokenDetails: { textTokens: 0, reasoningTokens: undefined },
      totalTokens: 1_000_000,
    };
    // 600k * $1.00/M + 300k * $0.10/M + 100k * $0.50/M = 0.6 + 0.03 + 0.05 = 0.68
    const report = reportForGroq("cached-model", cachedUsage, fixtureCatalog);
    expect(report.status).toBe("estimated");
    expect(report.amountUsd).toBeCloseTo(0.68, 6);
  });

  test("falls back to the full input rate when the catalog entry has no cache-specific pricing", () => {
    const cachedUsage: LanguageModelUsage = {
      inputTokens: 1_000_000,
      inputTokenDetails: {
        noCacheTokens: 500_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: undefined,
      },
      outputTokens: 0,
      outputTokenDetails: { textTokens: 0, reasoningTokens: undefined },
      totalTokens: 1_000_000,
    };
    // llama-3.3-70b-versatile has no cacheReadPerMTok — the whole 1M still prices at $0.59/M.
    const report = reportForGroq("llama-3.3-70b-versatile", cachedUsage, fixtureCatalog);
    expect(report.amountUsd).toBeCloseTo(0.59, 6);
  });
});
