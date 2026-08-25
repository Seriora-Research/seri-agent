import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import type { JSONValue } from "ai";

// Returns the tiers legal to offer a user for `entry` — an `effort` entry's named values win
// over a `toggle` entry when a model's reasoningOptions array has both (e.g. GLM 5.2, which
// lists toggle+effort+budget_tokens together): `effort`'s "none" already covers "off", making
// toggle redundant once effort tiers exist. A `budget_tokens`-only entry is excluded (no
// min/max/default in the live models.dev catalog today — see spec 032's research.md §3), as is
// a model with no reasoningOptions at all.
export function legalTiersFor(entry?: ModelCatalogEntry): string[] {
  // `Array.isArray`, not a bare `?? []`: models.dev is an external, unvalidated source and
  // catalog.ts does no runtime schema validation (TS type cast only, round-2 review item 11) — a
  // response where `reasoning_options` itself isn't an array (a single object instead of a
  // one-element array, the same class of upstream shape drift research.md's own Risks section
  // already warns is recurring) would otherwise reach `opts.find(...)` below and throw
  // `TypeError: opts.find is not a function`, straight out of loop.ts's hot-path re-validation
  // gate, breaking every turn for that model instead of degrading to "no tiers offered."
  const raw = entry?.reasoningOptions;
  const opts = Array.isArray(raw) ? raw : [];
  const effort = opts.find((o) => o.type === "effort");
  // `?? []`, not a bare `effort.values`: a malformed `{type: "effort"}` entry with no `values`
  // field would otherwise return `undefined` here — which throws `TypeError: undefined.includes`
  // at loop.ts's own re-validation gate on the hot turn path, breaking the whole turn over a
  // catalog data problem, not just /effort (round-2 review item, prior fix).
  if (effort) return effort.values ?? [];
  const toggle = opts.find((o) => o.type === "toggle");
  if (toggle) return ["off", "on"];
  return [];
}

// Whether `tier` is actually legal for `entry` right now, and if so, `tier` itself — otherwise
// `undefined`. The one source of truth both loop.ts (does this turn's request actually carry
// providerOptions for this tier) and cli.ts's own persist-on-success gate (is this tier still
// legal for the route the turn that just succeeded actually used) must agree on, so a tier
// silently dropped on the send side is never persisted as the new config default either (round-2
// review item 10 — a stale `/effort` value surviving a `/model` switch to an incompatible route
// used to keep getting silently re-persisted every turn it was still sitting in session state).
export function appliedReasoningEffort(
  tier: string | undefined,
  entry?: ModelCatalogEntry,
): string | undefined {
  return tier !== undefined && legalTiersFor(entry).includes(tier) ? tier : undefined;
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
// Return type is `Record<string, Record<string, JSONValue>>` (streamText's own
// `providerOptions` shape), not spec 032's `Record<string, unknown>`: `unknown` does not
// structurally satisfy the AI SDK's `SharedV4ProviderOptions`, so passing it straight to
// `streamText` failed to typecheck — the values built below were already JSON-safe.
export function buildReasoningProviderOptions(
  provider: ModelProvider,
  tier: string,
): Record<string, Record<string, JSONValue>> {
  if (tier === "off" || tier === "none") {
    // A real disable shape per provider (round-2 review item 2), not `{}` for every provider but
    // OpenRouter — `{}` means "send no providerOptions at all," which lets the provider's own
    // default reasoning behavior apply, not "off." Each shape below is verified against the same
    // installed @ai-sdk/* type definitions the enabled-tier switch below was verified against.
    switch (provider) {
      case "anthropic":
        // `{type: "disabled"}` is a real, named member of the SDK's own thinking union — not an
        // omission standing in for "disabled" the way the enabled-tier budgetTokens table is.
        return { anthropic: { thinking: { type: "disabled" } } };
      case "google":
        // No "disabled" member exists in @ai-sdk/google's own thinkingConfig type (only
        // thinkingBudget?: number / thinkingLevel?: string) — thinkingBudget: 0 is Gemini's own
        // documented mechanism for turning thinking off on a model that supports it.
        return { google: { thinkingConfig: { thinkingBudget: 0 } } };
      case "openai":
      case "groq":
        // "none" is a real member of both SDKs' own reasoningEffort union (openai:
        // "none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"; groq:
        // "none"|"default"|"low"|"medium"|"high") — not a value invented for this branch.
        return { [provider]: { reasoningEffort: "none" } };
      case "openrouter":
        return { openrouter: { reasoning: { enabled: false } } };
    }
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
