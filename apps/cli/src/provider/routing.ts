import {
  CATALOG_PROVIDERS,
  findCatalogEntry,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProvider,
  routesFor,
} from "@seri/model-catalog";
import type { Plan } from "@seri/plans";
import { effectiveHostedPlan, hostedPlanUsable } from "../auth/seriIgnore";
import { DEFAULT_PROVIDER, resolveDefaultModel } from "./defaults";
import { PROVIDER_API_KEY_NAMES } from "./keys";
import { GATEWAY_PROVIDER, planCoverage } from "./planCoverage";
import { legalTiersFor } from "./reasoning";
import { subscribedProviders } from "./subscriptions";

// D2 (feature-plan.md): "native-direct" for tie-breaking is these three providers specifically —
// not derived from routeKey's own vendor string, which would also call groq/openrouter "direct"
// for their OWN bare-id entries (e.g. groq's llama-3.3-70b-versatile). The distinction that
// matters for routing priority is aggregator-vs-not, and groq/openrouter are the two aggregators
// in CATALOG_PROVIDERS today; anthropic/openai/google never proxy another vendor's models.
//
// `Record<ModelProvider, boolean>`, not a bare `Set` literal (code-review finding, PR #73, round
// 3, item #10, mirroring PROVIDER_API_KEY_NAMES's own established pattern, keys.ts): a `Set`
// built from a hand-picked literal array has no compile-time tie to `ModelProvider` at all — a 6th
// provider added to CATALOG_PROVIDERS/ModelProvider but forgotten here used to silently fall into
// the aggregator tier (wrong reroute priority, wrong /model picker ordering) with no compiler
// error. A `Record` with one entry per `ModelProvider` member makes a forgotten one a COMPILE
// error (missing property) instead, the same guarantee `isModelProvider` (provider/defaults.ts)
// explicitly does NOT have (its own comment: it derives membership from CATALOG_PROVIDERS at
// runtime only, because it has no per-provider payload to type-check against — this one does).
export const NATIVE_PROVIDERS: Record<ModelProvider, boolean> = {
  anthropic: true,
  openai: true,
  google: true,
  groq: false,
  openrouter: false,
  // api.x.ai is xAI's own first-party endpoint and never proxies another vendor's models, which
  // is exactly this table's criterion. It is also what makes a connected SuperGrok subscription
  // beat an OpenRouter key for the same grok model without a second precedence rule.
  xai: true,
};

// The native-then-aggregator, CATALOG_PROVIDERS-tiebroken ordering rule 2 applies — exported so
// /model's own picker (tui/commands.ts's decideModelPickerOpen) can order a route group's members
// in the SAME order routing would actually choose them, rather than re-deriving an independent
// copy of this comparator that could silently drift from it.
export function byRoutePriority(a: ModelCatalogEntry, b: ModelCatalogEntry): number {
  const aTier = NATIVE_PROVIDERS[a.provider] ? 0 : 1;
  const bTier = NATIVE_PROVIDERS[b.provider] ? 0 : 1;
  if (aTier !== bTier) return aTier - bTier;
  return CATALOG_PROVIDERS.indexOf(a.provider) - CATALOG_PROVIDERS.indexOf(b.provider);
}

// What pays for a resolved route. "key" is a BYOK console key from env or config.json;
// "gateway" is seri's own hosted account. A third member arrives with the Grok subscription
// "subscription" is a vendor OAuth grant against the user's own consumer plan — the user's
// credential, like "key", but flat-rate rather than metered, which is why cost.ts reports it as
// included rather than pricing it from the catalog.
export type RouteCredential = "key" | "subscription" | "gateway";

export type ResolvedRoute = {
  model: string;
  provider: ModelProvider;
  rerouted: boolean;
  // The requested provider's OWN key name (e.g. "OPENROUTER_API_KEY"), present only when
  // `rerouted` is true — cli.ts's transcript notice reads this to name what was missing, per D2's
  // "a reroute is never silent" rule. Not a full sentence: the message shape belongs to the
  // presentation layer (cli.ts), same split as everywhere else in this codebase.
  reason?: string;
  // Which credential class actually pays for this route. Replaces the former `viaGateway`
  // boolean, which was already a credential flag wearing a boolean's clothes: "gateway" meant
  // seri's hosted account pays, and `false` meant the user's own key does. A single field rather
  // than a second boolean beside the first, so the state where both are somehow true is not
  // representable. Non-optional, like `rerouted`: every consumer gets a real value.
  //
  // "gateway" is still reached only when no local key exists ANYWHERE for this model (Rule 1 and
  // Rule 2 have both failed) and the caller's plan covers the entry — the gateway is the fallback
  // for a provider the user never brought a key for, never a substitute for one they did.
  credential: RouteCredential;
};

// The group-scoped half of gatewayCoverage, below — split out so a caller that already holds
// `entry`'s route group (decideModelPickerOpen, which groups the whole catalog once via
// groupRoutes before asking this per row) can reuse it directly instead of paying routesFor's own
// O(catalog size) filter+routeKey-recompute scan again for every row in that same group.
export function gatewayCoverageInGroup(
  group: readonly ModelCatalogEntry[],
  plan: Plan | null,
  // A usable WorkOS login whose plan fetch failed (or never ran) still pays
  // through the gateway. Quota is the server's job; asking for
  // OPENROUTER_API_KEY here is the wrong refusal for that state.
  hostedActive = false,
): ModelCatalogEntry | undefined {
  const gatewayEntry = group.find((candidate) => candidate.provider === GATEWAY_PROVIDER);
  if (gatewayEntry === undefined) return undefined;
  if (planCoverage(gatewayEntry, plan)) return gatewayEntry;
  if (hostedActive && plan === null) return gatewayEntry;
  return undefined;
}

// The single lookup both resolveRoute's own gateway branch AND the /model picker's coverage
// predicate (cli.ts, decideModelPickerOpen's own planCoverage callback) must share — the same
// drift risk byRoutePriority's own comment names for the reroute case, now applying to the gateway
// case too: without ONE shared function, the picker could show "seri" for an entry resolveRoute
// would never actually route through the gateway (or the reverse), the two surfaces silently
// disagreeing about what the same row means. Returns the OpenRouter-catalog
// sibling entry when the gateway can actually serve `entry`'s route group under `plan`, `undefined`
// otherwise — `undefined` rather than a bare boolean so a caller that also needs the resolved
// model/provider (resolveRoute) doesn't have to re-look it up a second time. resolveRoute calls
// this once per turn with a single `entry`, so paying routesFor's own scan here is fine; a caller
// iterating many entries against the same catalog should call gatewayCoverageInGroup instead.
export function gatewayCoverage(
  catalog: ModelCatalog,
  entry: ModelCatalogEntry,
  plan: Plan | null,
  hostedActive = false,
): ModelCatalogEntry | undefined {
  return gatewayCoverageInGroup(routesFor(catalog.entries, entry), plan, hostedActive);
}

const EMPTY_SUBSCRIPTIONS: ReadonlySet<ModelProvider> = new Set();

// A leftover OpenRouter key must not beat an active seri plan — same as Grok/Codex leftover
// keys. Drop GATEWAY_PROVIDER from the key set when a plan is in play so Rule 1/2 fall
// through to Rule 4. Ignoring the plan (seri-ignore) passes plan: null and the key is used.
function keysForRouting(
  configured: ReadonlySet<ModelProvider>,
  plan: Plan | null,
): ReadonlySet<ModelProvider> {
  if (plan === null || !configured.has(GATEWAY_PROVIDER)) return configured;
  const next = new Set(configured);
  next.delete(GATEWAY_PROVIDER);
  return next;
}

// Subscription over key when a user holds both for the same provider. Both are the user's own
// credential, so the only asymmetry is marginal cost: the subscription is already paid and
// flat-rate, while the key bills per token. Spending money when a paid-for alternative is
// connected is the wrong default. /setup has to say the key is present and unused, or a user
// will reasonably think their key is broken.
function credentialFor(
  provider: ModelProvider,
  subscribed: ReadonlySet<ModelProvider>,
): RouteCredential {
  return subscribed.has(provider) ? "subscription" : "key";
}

// D2's three-rule priority order, implemented as a pure function: no `process.env`, no
// `loadConfig` — `configured` is the caller's own single source of truth (apps/cli/src/provider/
// keys.ts's `configuredProviders`), which is what keeps every test here independent of the
// ambient environment (`.claude/rules/code-quality.md`'s env-var-dependence rule).
export function resolveRoute(
  catalog: ModelCatalog,
  requested: { model: string; provider: ModelProvider },
  configured: ReadonlySet<ModelProvider>,
  plan: Plan | null = null,
  // Providers reachable by a connected vendor subscription. Appended optional, mirroring how
  // `plan` itself arrived, so every existing call site stays valid; today it is empty, {"xai"},
  // {"openai"}, or both. A separate set rather than a member of `configured` because the two answer
  // different questions — `configured` means "has an API key", which a subscription does not.
  subscribed: ReadonlySet<ModelProvider> = EMPTY_SUBSCRIPTIONS,
  hostedActive = false,
): ResolvedRoute {
  // Every early-return branch below stays on `requested` unchanged (code-review finding, PR #73,
  // round 2, item #9 — the four branches used to hand-duplicate this identical literal).
  const keys = keysForRouting(configured, plan);
  const noReroute: ResolvedRoute = {
    model: requested.model,
    provider: requested.provider,
    rerouted: false,
    credential: credentialFor(requested.provider, subscribed),
  };

  // Rule 1: an explicit pick whose own provider has a key (or vendor subscription) wins —
  // never second-guessed even when a native sibling also has one. An active seri plan is
  // the exception for OpenRouter: that leftover key is unused, same as a leftover xAI key
  // next to a connected Grok plan.
  if (keys.has(requested.provider) || subscribed.has(requested.provider)) {
    return noReroute;
  }

  const entry = findCatalogEntry(catalog, requested.model, requested.provider);
  // An id absent from the catalog (typed straight into SERI_MODEL, say) has no route group to
  // reroute within — left exactly as requested so getModel throws its own, already-tested
  // missing-key error, not a routing decision about a group that does not exist.
  if (entry === undefined) {
    return noReroute;
  }

  const candidates = routesFor(catalog.entries, entry).filter(
    (candidate) =>
      candidate.provider !== requested.provider &&
      (keys.has(candidate.provider) || subscribed.has(candidate.provider)),
  );
  // Reached only when no sibling provider has a configured key either — Rule 1 and Rule 2 have
  // both already failed to find one. The gateway covering the model under `plan` is the 4th
  // outcome; a configured sibling above still wins over it unconditionally, since this branch is
  // never reached when one exists.
  if (candidates.length === 0) {
    const gatewayEntry = gatewayCoverage(catalog, entry, plan, hostedActive);
    if (gatewayEntry !== undefined) {
      // model/provider become GATEWAY_PROVIDER's own — the id the server's catalog lookup and
      // upstream forward will actually recognize, not the originally-requested provider's id.
      // `rerouted: false`, not true: that flag means "a locally configured key exists on a
      // sibling provider" (Rule 2), which is not the case here — formatRouteLabel keeps
      // "→ provider" and "seri" as distinct, mutually exclusive states.
      return {
        model: gatewayEntry.id,
        provider: gatewayEntry.provider,
        rerouted: false,
        credential: "gateway",
      };
    }
    return noReroute;
  }

  // Rule 2: native-direct over aggregator, ties within a tier broken by CATALOG_PROVIDERS order —
  // sorted once rather than a hand-rolled two-pass "find native, else find aggregator" search.
  // `chosen` is typed `ModelCatalogEntry`, not `| undefined`, by tsc itself — array destructuring
  // does not go through `noUncheckedIndexedAccess` (that flag is not even enabled in this
  // project's own tsconfig.json), and a defensive `if (chosen === undefined)` branch here was
  // dead code satisfying neither a real runtime case (the `candidates.length === 0` guard above
  // already rules that out) nor the compiler — removed (code-review finding, PR #73, round 3,
  // item #9), verified by compiling the equivalent destructure in isolation rather than assumed.
  const [chosen] = [...candidates].sort(byRoutePriority);

  return {
    model: chosen.id,
    provider: chosen.provider,
    rerouted: true,
    reason: PROVIDER_API_KEY_NAMES[requested.provider],
    credential: credentialFor(chosen.provider, subscribed),
  };
}

// Extracted after the identical triplet — `session.model ??
// resolveDefaultModel(configDir).model`, `session.provider ?? DEFAULT_PROVIDER`, then
// `resolveRoute(...)` — was independently copy-pasted at four call sites in cli.ts (prepareSession,
// runTurn, effortCommand, and the /effort bare-form interception). `session` is a minimal
// structural shape, not `SessionState`, so this module stays decoupled from session.ts (no other
// function here needs it) — every real caller's SessionState/RunSession already satisfies it.
// `session.model` is guaranteed non-undefined at two of the four original call sites
// (prepareSession, runTurn — both work with an already-backfilled RunSession); the `??
// resolveDefaultModel(...)` fallback is simply dead code there, not a behavior change, so one
// shared implementation safely covers both shapes.
export function resolveSessionRoute(
  session: { model?: string; provider?: ModelProvider },
  catalog: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
  plan: Plan | null,
  configDir: string,
): ResolvedRoute {
  // `resolveDefaultModel(configDir)`'s OWN `.provider`, not a hardcoded `DEFAULT_PROVIDER`:
  // `provider` can legitimately be undefined on `session` (RunSession's own
  // comment, cli.ts — "no provider was ever explicitly requested"), and `resolveDefaultModel`
  // already resolves the correct pair for that case — e.g. SERI_MODEL=claude-sonnet-5 +
  // SERI_PROVIDER=anthropic configured, no session override, used to resolve as claude-sonnet-5 on
  // DEFAULT_PROVIDER ("groq") regardless, a wrong-provider dispatch or an invalid model id for
  // that provider. `DEFAULT_PROVIDER` is still the final fallback — `resolveDefaultModel` itself
  // returns `provider: undefined` when nothing was ever configured (env or config.json), the one
  // case a concrete provider is still needed for routing.
  const defaults = resolveDefaultModel(configDir);
  const model = session.model ?? defaults.model;
  const provider = session.provider ?? defaults.provider ?? DEFAULT_PROVIDER;
  // Read here rather than threaded from every caller: this function already reads configDir for
  // resolveDefaultModel, so it is the one place that can answer "is a subscription connected"
  // without making resolveRoute itself impure.
  return resolveRoute(
    catalog,
    { model, provider },
    configured,
    effectiveHostedPlan(configDir, plan),
    subscribedProviders(configDir),
    hostedPlanUsable(configDir),
  );
}

// Route-aware, not a static per-model lookup: the same
// model id can resolve to different catalog entries — and thus different
// legal reasoning tiers — depending on whether `route.provider` ends up being "openrouter" or a
// direct provider, so this must key off `route`'s actual resolved (model, provider) pair.
export function resolveLegalReasoningTiers(route: ResolvedRoute, catalog: ModelCatalog): string[] {
  return legalTiersFor(findCatalogEntry(catalog, route.model, route.provider));
}
