import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import type { JSONValue } from "ai";
import { loadReasoningEffortConfig } from "../config/config";

export function legalTiersFor(entry?: ModelCatalogEntry): string[] {
  // models.dev is unvalidated JSON.
  const raw = entry?.reasoningOptions;
  const opts = Array.isArray(raw) ? raw : [];

  const effort = opts.find((o) => o != null && typeof o === "object" && o.type === "effort");

  if (effort) return Array.isArray(effort.values) ? effort.values : [];
  const toggle = opts.find((o) => o != null && typeof o === "object" && o.type === "toggle");
  if (toggle) return ["off", "on"];
  return [];
}

export function appliedReasoningEffort(
  tier: string | undefined,
  entry?: ModelCatalogEntry,
): string | undefined {
  return tier !== undefined && legalTiersFor(entry).includes(tier) ? tier : undefined;
}

export function resolveReasoningEffort(
  session: { reasoningEffort?: string },
  config: Record<string, string>,
): string | undefined {
  return session.reasoningEffort ?? loadReasoningEffortConfig(config);
}

export type EffortCommandResult =
  | { changed: false; message: string }
  | { changed: true; reasoningEffort: string | undefined; message: string };

export function resolveEffortCommand(
  args: string[],
  legalTiers: string[],
  current: string | undefined,
): EffortCommandResult {
  if (args.length === 0) {
    if (legalTiers.length === 0) {
      return {
        changed: false,
        message: `Reasoning effort: ${current ?? "unset"} (this model has no reasoning-effort tiers available)`,
      };
    }

    if (current !== undefined && !legalTiers.includes(current)) {
      return {
        changed: false,
        message: `Reasoning effort: ${current} is set but not legal for the current model — it will be dropped. Legal tiers: ${legalTiers.join(", ")}.`,
      };
    }
    return {
      changed: false,
      message: `Reasoning effort: ${current ?? "unset"}. Legal tiers for the current model: ${legalTiers.join(", ")}.`,
    };
  }

  if (args[0] === "auto") {
    return {
      changed: true,
      reasoningEffort: undefined,
      message: "Reasoning effort: auto (falls back to the config default).",
    };
  }

  const [tier] = args;
  if (tier === undefined || !legalTiers.includes(tier)) {
    return {
      changed: false,
      message:
        legalTiers.length === 0
          ? "This model has no reasoning-effort tiers available."
          : `Invalid reasoning effort "${tier}". Legal tiers: ${legalTiers.join(", ")}.`,
    };
  }
  return { changed: true, reasoningEffort: tier, message: `Reasoning effort: ${tier}` };
}

function assertNever(x: never): never {
  throw new Error(`Unhandled provider: ${String(x)}`);
}

// Anthropic's SDK has no named-tier param, only budgetTokens.
const ANTHROPIC_EFFORT_BUDGET_TOKENS: Record<string, number> = {
  low: 4096,
  medium: 10000,
  high: 20000,
  xhigh: 26000,
  max: 32000,
};

export function buildReasoningProviderOptions(
  provider: ModelProvider,
  tier: string,
): Record<string, Record<string, JSONValue>> {
  if (tier === "off" || tier === "none") {
    // {} sends no providerOptions, which lets the provider default apply.
    switch (provider) {
      case "anthropic":
        return { anthropic: { thinking: { type: "disabled" } } };
      case "google":
        // thinkingBudget: 0 is Gemini's documented off switch; the SDK has no disabled member.
        return { google: { thinkingConfig: { thinkingBudget: 0 } } };
      case "openai":
      case "groq":
        return { [provider]: { reasoningEffort: "none" } };
      case "xai":
        // @ai-sdk/openai parseProviderOptions({ provider: "openai" }); an { xai: ... } key is ignored.
        return { openai: { reasoningEffort: "none" } };
      case "openrouter":
        return { openrouter: { reasoning: { enabled: false } } };

      default:
        return assertNever(provider);
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

    case "xai":
      return { openai: { reasoningEffort: tier === "on" ? "medium" : tier } };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: tier === "on" ? "medium" : tier } } };
    case "openrouter":
      return tier === "on"
        ? { openrouter: { reasoning: { enabled: true } } }
        : { openrouter: { reasoning: { effort: tier } } };
  }
}
