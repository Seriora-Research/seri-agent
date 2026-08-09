import { findCatalogEntry, type ModelCatalog } from "@seri/model-catalog";
import type { LanguageModelUsage, ProviderMetadata } from "ai";

// TS string-literal unions, not enums or classes — matching this file's sibling PermissionMode
// (gate/gate.ts) and ApprovalAnswer (loop/loop.ts) style.
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

// `providerMetadata.openrouter.usage.cost` — confirmed against the installed
// @openrouter/ai-sdk-provider@3.0.0 types (dist/index.d.ts): OpenRouterChatLanguageModel's
// doGenerate/doStream both type their returned providerMetadata as
// `{ openrouter: { provider: string; usage: OpenRouterUsageAccounting } }`, and
// OpenRouterUsageAccounting.cost is `number | undefined`. The AI SDK's own ProviderMetadata type
// (`ai`'s streamText/generateText result) only narrows this to `Record<string, JSONObject>`, so the
// nested shape below is asserted against the confirmed real shape, not inferred from `ai`'s types.
// `providerMetadata` is a Promise on streamText results — the caller must await it after the stream
// ends before calling this; it is a plain value on generateText.
type OpenRouterProviderMetadata = { openrouter?: { usage?: { cost?: number } } };

export function reportForOpenRouter(
  _usage: LanguageModelUsage,
  providerMetadata: ProviderMetadata | undefined,
): CostReport {
  const amountUsd = (providerMetadata as OpenRouterProviderMetadata | undefined)?.openrouter?.usage
    ?.cost;
  return { amountUsd, status: "actual", source: "provider_cost_api" };
}

// Groq's API reports only tokens/time, never a dollar figure, so cost is computed from the
// catalog's models.dev-sourced pricing instead of a hand-maintained table. A model id absent from
// the catalog (real: Slice 2's manifest only has 6 of Groq's 15 live models) degrades to unknown
// rather than a stale guess.
export function reportForGroq(
  modelId: string,
  usage: LanguageModelUsage,
  catalog: ModelCatalog,
): CostReport {
  const entry = findCatalogEntry(catalog, modelId, "groq");
  if (!entry?.pricing) return { amountUsd: undefined, status: "unknown", source: "none" };
  const inputCost = ((usage.inputTokens ?? 0) / 1_000_000) * entry.pricing.inputPerMTok;
  const outputCost = ((usage.outputTokens ?? 0) / 1_000_000) * entry.pricing.outputPerMTok;
  return { amountUsd: inputCost + outputCost, status: "estimated", source: "provider_models_api" };
}
