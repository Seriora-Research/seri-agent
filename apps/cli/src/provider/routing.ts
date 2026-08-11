import {
  CATALOG_PROVIDERS,
  findCatalogEntry,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProvider,
  routesFor,
} from "@seri/model-catalog";
import { PROVIDER_API_KEY_NAMES } from "./keys";

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

export type ResolvedRoute = {
  model: string;
  provider: ModelProvider;
  rerouted: boolean;
  // The requested provider's OWN key name (e.g. "OPENROUTER_API_KEY"), present only when
  // `rerouted` is true — cli.ts's transcript notice reads this to name what was missing, per D2's
  // "a reroute is never silent" rule. Not a full sentence: the message shape belongs to the
  // presentation layer (cli.ts), same split as everywhere else in this codebase.
  reason?: string;
};

// D2's three-rule priority order, implemented as a pure function: no `process.env`, no
// `loadConfig` — `configured` is the caller's own single source of truth (apps/cli/src/provider/
// keys.ts's `configuredProviders`), which is what keeps every test here independent of the
// ambient environment (`.claude/rules/code-quality.md`'s env-var-dependence rule).
export function resolveRoute(
  catalog: ModelCatalog,
  requested: { model: string; provider: ModelProvider },
  configured: ReadonlySet<ModelProvider>,
): ResolvedRoute {
  // Every early-return branch below stays on `requested` unchanged (code-review finding, PR #73,
  // round 2, item #9 — the four branches used to hand-duplicate this identical literal).
  const noReroute: ResolvedRoute = {
    model: requested.model,
    provider: requested.provider,
    rerouted: false,
  };

  // Rule 1: an explicit pick whose own provider has a key wins, unconditionally — never
  // second-guessed even when a native sibling also has one (MULTI-PROVIDER-BYOK-ROUTING.md:121,
  // "picking the entry IS picking the route").
  if (configured.has(requested.provider)) {
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
    (candidate) => candidate.provider !== requested.provider && configured.has(candidate.provider),
  );
  if (candidates.length === 0) {
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
  };
}
