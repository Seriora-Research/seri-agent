import { findCatalogEntry, type ModelCatalog, type ModelProvider } from "@seri/model-catalog";
import type { LanguageModelUsage, ProviderMetadata } from "ai";

export type CostStatus = "actual" | "estimated" | "included" | "unknown";
export type CostSource =
  | "provider_cost_api"
  | "provider_generation_api"
  | "provider_models_api"
  | "official_docs_snapshot"
  | "user_override"
  | "custom_contract"
  | "none";
export type CostReport = { amountUsd: number | undefined; status: CostStatus; source: CostSource };

// streamText providerMetadata is a Promise; generateText's is a value.
type OpenRouterProviderMetadata = {
  openrouter?: { provider?: string; usage?: { cost?: number } };
};

export function openRouterServedProvider(
  providerMetadata: ProviderMetadata | undefined,
): string | undefined {
  const name = (providerMetadata as OpenRouterProviderMetadata | undefined)?.openrouter?.provider;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

export function reportForOpenRouter(
  _usage: LanguageModelUsage,
  providerMetadata: ProviderMetadata | undefined,
): CostReport {
  const amountUsd = (providerMetadata as OpenRouterProviderMetadata | undefined)?.openrouter?.usage
    ?.cost;

  // OpenRouter can omit usage.cost; missing is not $0.
  if (amountUsd === undefined) return { amountUsd: undefined, status: "unknown", source: "none" };
  return { amountUsd, status: "actual", source: "provider_cost_api" };
}

export function reportFromCatalogPricing(
  modelId: string,
  provider: ModelProvider,
  usage: LanguageModelUsage,
  catalog: ModelCatalog,
): CostReport {
  const entry = findCatalogEntry(catalog, modelId, provider);
  if (!entry?.pricing) return { amountUsd: undefined, status: "unknown", source: "none" };
  const { pricing } = entry;

  // usage.inputTokens is cached plus non-cached; pricing the total at the full rate double-bills cache.
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const noCacheTokens =
    usage.inputTokenDetails?.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens);

  const inputCost =
    (noCacheTokens / 1_000_000) * pricing.inputPerMTok +
    (cacheReadTokens / 1_000_000) * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok) +
    (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok);
  const outputCost = ((usage.outputTokens ?? 0) / 1_000_000) * pricing.outputPerMTok;
  return { amountUsd: inputCost + outputCost, status: "estimated", source: "provider_models_api" };
}

export function reportForSubscription(): CostReport {
  return { amountUsd: undefined, status: "included", source: "custom_contract" };
}
