import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import type { JSONValue } from "ai";
import { loadReasoningEffortConfig } from "../config/config";

// Returns the tiers legal to offer a user for `entry` — an `effort` entry's named values win
// over a `toggle` entry when a model's reasoningOptions array has both (e.g. GLM 5.2, which
// lists toggle+effort+budget_tokens together): `effort`'s "none" already covers "off", making
// toggle redundant once effort tiers exist. A `budget_tokens`-only entry is excluded (no
// min/max/default in the live models.dev catalog today), as is a model with no reasoningOptions
// at all.
export function legalTiersFor(entry?: ModelCatalogEntry): string[] {
  // `Array.isArray`, not a bare `?? []`: models.dev is an external, unvalidated source and
  // catalog.ts does no runtime schema validation (a TS type cast only) — a response where
  // `reasoning_options` itself isn't an array (a single object instead of a one-element array,
  // the same class of upstream shape drift this module has to assume can recur) would otherwise
  // reach `opts.find(...)` below and throw `TypeError: opts.find is not a function`, straight out
  // of loop.ts's hot-path re-validation gate, breaking every turn for that model instead of
  // degrading to "no tiers offered."
  const raw = entry?.reasoningOptions;
  const opts = Array.isArray(raw) ? raw : [];
  // `o != null && typeof o === "object"`, not a bare `o.type === "effort"`: a
  // well-formed ARRAY can still carry a malformed element — `reasoning_options: [null]` — and
  // reading `.type` off `null` throws the identical `TypeError` this function's own `Array.isArray`
  // guard above already exists to prevent for the array-vs-non-array case.
  const effort = opts.find((o) => o != null && typeof o === "object" && o.type === "effort");
  // `Array.isArray`, not a bare `?? []`: a present-but-non-array `values` field (e.g. `{}` or a
  // string) would otherwise pass through unchanged and break every downstream `.includes()`/
  // `.join()` caller — the same upstream-shape-drift class this function's own header comment
  // warns is recurring, just one field deeper.
  if (effort) return Array.isArray(effort.values) ? effort.values : [];
  const toggle = opts.find((o) => o != null && typeof o === "object" && o.type === "toggle");
  if (toggle) return ["off", "on"];
  return [];
}

// Whether `tier` is actually legal for `entry` right now, and if so, `tier` itself — otherwise
// `undefined`. The one source of truth both loop.ts (does this turn's request actually carry
// providerOptions for this tier) and cli.ts's own persist-on-success gate (is this tier still
// legal for the route the turn that just succeeded actually used) must agree on, so a tier
// silently dropped on the send side is never persisted as the new config default either — a stale
// `/effort` value surviving a `/model` switch to an incompatible route would otherwise keep
// getting silently re-persisted every turn it was still sitting in session state.
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
    // Don't report a session override as active when it is actually illegal for the currently
    // resolved route and gets silently dropped on send — appliedReasoningEffort (above) is the
    // same check loop.ts's own re-validation gate applies.
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

  // Destructured, not `args[0] as string`: `args.length === 0` was already
  // handled above, so `tier` is only ever `undefined` here if a future caller passes more than one
  // argument — SLASH_COMMANDS' own `accepts: (args) => args.length <= 1` and the TUI interception's
  // matching guard both already keep that from happening, but this reads as a real check rather
  // than an assertion of an invariant enforced two call sites away.
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

// Forces a compile error at the call site when `x` is not actually `never` — buildReasoningProviderOptions's
// own disabled-branch switch (below) is the one caller, added there because that switch, unlike its
// enabled-branch sibling, is not this function's terminal return and so gets no exhaustiveness
// check from tsc on its own (that switch's own comment has the full account).
function assertNever(x: never): never {
  throw new Error(`Unhandled provider: ${String(x)}`);
}

// Anthropic's SDK has no named-tier param, only a numeric budgetTokens — this fixed table is an
// approximation (high=20k, max=32k), a reasonable starting point rather than an invented number.
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
// providerOptions types exactly.
// Return type is `Record<string, Record<string, JSONValue>>` (streamText's own
// `providerOptions` shape), not the broader `Record<string, unknown>`: `unknown` does not
// structurally satisfy the AI SDK's `SharedV4ProviderOptions`, so passing it straight to
// `streamText` failed to typecheck — the values built below were already JSON-safe.
export function buildReasoningProviderOptions(
  provider: ModelProvider,
  tier: string,
): Record<string, Record<string, JSONValue>> {
  if (tier === "off" || tier === "none") {
    // A real disable shape per provider, not `{}` for every provider but
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
      // This switch is not the function's own terminal return (the
      // enabled-tier switch below is, and IS exhaustiveness-checked by tsc for free — falling off
      // it without a case is a "not all code paths return a value" error with no default needed).
      // This one sits inside an `if` block, so falling off it without a case is NOT a compile
      // error — execution just continues into the enabled-tier switch below, silently sending the
      // ENABLED shape for a tier the user asked to turn off. `assertNever` makes a 6th provider
      // added to ModelProvider without a case here a compile error instead: once every real case
      // above narrows `provider` to `never`, `assertNever(provider)` typechecks; a provider with no
      // case does not.
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
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: tier === "on" ? "medium" : tier } } };
    case "openrouter":
      return tier === "on"
        ? { openrouter: { reasoning: { enabled: true } } }
        : { openrouter: { reasoning: { effort: tier } } };
  }
}
