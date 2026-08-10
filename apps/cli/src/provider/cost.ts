import { findCatalogEntry, type ModelCatalog, type ModelProvider } from "@seri/model-catalog";
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
  // A missing cost is not an actual $0 — OpenRouter can omit `usage.cost` (no accounting configured,
  // an unlisted model, a provider that doesn't report it), and labelling that "actual" would show a
  // dollar figure nobody measured. reportFromCatalogPricing already draws this same "no data →
  // unknown" line for its own missing-pricing case; this mirrors it for OpenRouter's missing-cost
  // case.
  if (amountUsd === undefined) return { amountUsd: undefined, status: "unknown", source: "none" };
  return { amountUsd, status: "actual", source: "provider_cost_api" };
}

// Any provider whose API reports tokens but no dollar figure — today Groq, Anthropic, OpenAI and
// Google — so cost is computed from the catalog's models.dev-sourced pricing instead of a
// hand-maintained table. A model id absent from the catalog (real: Slice 2's manifest only has 6
// of Groq's 15 live models) degrades to unknown rather than a stale guess.
export function reportFromCatalogPricing(
  modelId: string,
  provider: ModelProvider,
  usage: LanguageModelUsage,
  catalog: ModelCatalog,
): CostReport {
  const entry = findCatalogEntry(catalog, modelId, provider);
  if (!entry?.pricing) return { amountUsd: undefined, status: "unknown", source: "none" };
  const { pricing } = entry;
  // A code-review finding: pricing ALL of usage.inputTokens at the full rate double-bills whatever
  // portion was actually a cache read/write, once the catalog entry has cache pricing at all —
  // usage.inputTokens is the total (cached + non-cached), not the non-cached count alone.
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const noCacheTokens =
    usage.inputTokenDetails?.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens);
  // Falls back to the full input rate for a catalog entry with no cache-specific pricing, rather
  // than assuming a discount the catalog never actually reported.
  const inputCost =
    (noCacheTokens / 1_000_000) * pricing.inputPerMTok +
    (cacheReadTokens / 1_000_000) * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok) +
    (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok);
  const outputCost = ((usage.outputTokens ?? 0) / 1_000_000) * pricing.outputPerMTok;
  return { amountUsd: inputCost + outputCost, status: "estimated", source: "provider_models_api" };
}
