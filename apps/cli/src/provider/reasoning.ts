import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";

// Returns the tiers legal to offer a user for `entry` — an `effort` entry's named values win
// over a `toggle` entry when a model's reasoningOptions array has both (e.g. GLM 5.2, which
// lists toggle+effort+budget_tokens together): `effort`'s "none" already covers "off", making
// toggle redundant once effort tiers exist. A `budget_tokens`-only entry is excluded (no
// min/max/default in the live models.dev catalog today — see spec 032's research.md §3), as is
// a model with no reasoningOptions at all.
export function legalTiersFor(entry?: ModelCatalogEntry): string[] {
  const opts = entry?.reasoningOptions ?? [];
  const effort = opts.find((o) => o.type === "effort");
  if (effort) return effort.values;
  const toggle = opts.find((o) => o.type === "toggle");
  if (toggle) return ["off", "on"];
  return [];
}

// Anthropic's SDK has no named-tier param, only a numeric budgetTokens — this fixed table is an
// approximation, sourced from opencode's own built-in Anthropic variants (high=20k, max=32k) as
// a reasonable, externally-validated starting point rather than an invented number.
const ANTHROPIC_EFFORT_BUDGET_TOKENS: Record<string, number> = {
  low: 4096,
  medium: 10000,
  high: 20000,
  xhigh: 26000,
  max: 32000,
};

// Verified against this repo's installed @ai-sdk/anthropic@4.0.36, @ai-sdk/openai@4.0.36,
// @ai-sdk/google@4.0.39, @ai-sdk/groq@4.0.19/4.0.26, and @openrouter/ai-sdk-provider@3.0.0 type
// definitions (node_modules) — every shape below matches the installed packages' own
// providerOptions types exactly, no corrections needed from spec 032's Contract section.
export function buildReasoningProviderOptions(
  provider: ModelProvider,
  tier: string,
): Record<string, unknown> {
  if (tier === "off" || tier === "none") {
    return provider === "openrouter" ? { openrouter: { reasoning: { enabled: false } } } : {};
  }
  switch (provider) {
    case "anthropic":
      return {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens:
              ANTHROPIC_EFFORT_BUDGET_TOKENS[tier] ?? ANTHROPIC_EFFORT_BUDGET_TOKENS.medium,
          },
        },
      };
    case "openai":
    case "groq":
      return { [provider]: { reasoningEffort: tier === "on" ? "medium" : tier } };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: tier === "on" ? "medium" : tier } } };
    case "openrouter":
      return tier === "on"
        ? { openrouter: { reasoning: { enabled: true } } }
        : { openrouter: { reasoning: { effort: tier } } };
  }
}
