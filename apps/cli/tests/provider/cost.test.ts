import { describe, expect, test } from "bun:test";
import type { ModelCatalog } from "@seri/model-catalog";
import type { LanguageModelUsage, ProviderMetadata } from "ai";
import { reportForOpenRouter, reportFromCatalogPricing } from "../../src/provider/cost";

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
    {
      id: "claude-cached-model",
      provider: "anthropic",
      displayName: "Claude Cached Model",
      family: "claude",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      toolCall: true,
      reasoning: false,
      pricing: {
        inputPerMTok: 3.0,
        outputPerMTok: 15.0,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
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

describe("reportFromCatalogPricing", () => {
  test("computes cost from the catalog entry's pricing", () => {
    expect(
      reportFromCatalogPricing(
        "llama-3.3-70b-versatile",
        "groq",
        usage(1_000_000, 1_000_000),
        fixtureCatalog,
      ),
    ).toEqual({
      amountUsd: 1.38,
      status: "estimated",
      source: "provider_models_api",
    });
  });

  test("returns unknown/none for a model id absent from the catalog", () => {
    expect(
      reportFromCatalogPricing("some-unlisted-model", "groq", usage(100, 50), fixtureCatalog),
    ).toEqual({
      amountUsd: undefined,
      status: "unknown",
      source: "none",
    });
  });

  // The negative control for the `provider` parameter this plan adds: "llama-3.3-70b-versatile"
  // exists in the catalog, but only under "groq" — asking for it under "anthropic" must miss the
  // lookup and degrade to unknown, not silently find the groq entry. This is the one case that
  // would still pass if a hardcoded "groq" survived inside findCatalogEntry's call, unnoticed by
  // every other test in this file.
  test("returns unknown/none when the model id exists in the catalog but under a different provider", () => {
    expect(
      reportFromCatalogPricing(
        "llama-3.3-70b-versatile",
        "anthropic",
        usage(100, 50),
        fixtureCatalog,
      ),
    ).toEqual({
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
    const report = reportFromCatalogPricing("cached-model", "groq", cachedUsage, fixtureCatalog);
    expect(report.status).toBe("estimated");
    expect(report.amountUsd).toBeCloseTo(0.68, 6);
  });

  // The branch Anthropic actually exercises (D4's own finding: its usage carries
  // inputTokenDetails.cacheReadTokens/cacheWriteTokens), proven against an anthropic catalog
  // entry rather than reusing the groq fixture above.
  test("prices an anthropic entry's cache-read tokens at its cache rate", () => {
    const cachedUsage: LanguageModelUsage = {
      inputTokens: 1_000_000,
      inputTokenDetails: {
        noCacheTokens: 700_000,
        cacheReadTokens: 300_000,
        cacheWriteTokens: undefined,
      },
      outputTokens: 0,
      outputTokenDetails: { textTokens: 0, reasoningTokens: undefined },
      totalTokens: 1_000_000,
    };
    // 700k * $3.00/M + 300k * $0.30/M = 2.1 + 0.09 = 2.19
    const report = reportFromCatalogPricing(
      "claude-cached-model",
      "anthropic",
      cachedUsage,
      fixtureCatalog,
    );
    expect(report.status).toBe("estimated");
    expect(report.amountUsd).toBeCloseTo(2.19, 6);
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
    const report = reportFromCatalogPricing(
      "llama-3.3-70b-versatile",
      "groq",
      cachedUsage,
      fixtureCatalog,
    );
    expect(report.amountUsd).toBeCloseTo(0.59, 6);
  });
});
