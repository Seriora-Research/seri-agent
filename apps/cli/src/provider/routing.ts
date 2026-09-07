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

export const NATIVE_PROVIDERS: Record<ModelProvider, boolean> = {
  anthropic: true,
  openai: true,
  google: true,
  groq: false,
  openrouter: false,

  xai: true,
};

export function byRoutePriority(a: ModelCatalogEntry, b: ModelCatalogEntry): number {
  const aTier = NATIVE_PROVIDERS[a.provider] ? 0 : 1;
  const bTier = NATIVE_PROVIDERS[b.provider] ? 0 : 1;
  if (aTier !== bTier) return aTier - bTier;
  return CATALOG_PROVIDERS.indexOf(a.provider) - CATALOG_PROVIDERS.indexOf(b.provider);
}

export type RouteCredential = "key" | "subscription" | "gateway";

export type ResolvedRoute = {
  model: string;
  provider: ModelProvider;
  rerouted: boolean;

  reason?: string;

  credential: RouteCredential;
};

export function gatewayCoverageInGroup(
  group: readonly ModelCatalogEntry[],
  plan: Plan | null,

  hostedActive = false,
): ModelCatalogEntry | undefined {
  const gatewayEntry = group.find((candidate) => candidate.provider === GATEWAY_PROVIDER);
  if (gatewayEntry === undefined) return undefined;
  if (planCoverage(gatewayEntry, plan)) return gatewayEntry;
  if (hostedActive && plan === null) return gatewayEntry;
  return undefined;
}

export function gatewayCoverage(
  catalog: ModelCatalog,
  entry: ModelCatalogEntry,
  plan: Plan | null,
  hostedActive = false,
): ModelCatalogEntry | undefined {
  return gatewayCoverageInGroup(routesFor(catalog.entries, entry), plan, hostedActive);
}

const EMPTY_SUBSCRIPTIONS: ReadonlySet<ModelProvider> = new Set();

function keysForRouting(
  configured: ReadonlySet<ModelProvider>,
  plan: Plan | null,
): ReadonlySet<ModelProvider> {
  if (plan === null || !configured.has(GATEWAY_PROVIDER)) return configured;
  const next = new Set(configured);
  next.delete(GATEWAY_PROVIDER);
  return next;
}

function credentialFor(
  provider: ModelProvider,
  subscribed: ReadonlySet<ModelProvider>,
): RouteCredential {
  return subscribed.has(provider) ? "subscription" : "key";
}

export function resolveRoute(
  catalog: ModelCatalog,
  requested: { model: string; provider: ModelProvider },
  configured: ReadonlySet<ModelProvider>,
  plan: Plan | null = null,

  subscribed: ReadonlySet<ModelProvider> = EMPTY_SUBSCRIPTIONS,
  hostedActive = false,
): ResolvedRoute {
  const keys = keysForRouting(configured, plan);
  const noReroute: ResolvedRoute = {
    model: requested.model,
    provider: requested.provider,
    rerouted: false,
    credential: credentialFor(requested.provider, subscribed),
  };

  if (keys.has(requested.provider) || subscribed.has(requested.provider)) {
    return noReroute;
  }

  const entry = findCatalogEntry(catalog, requested.model, requested.provider);

  if (entry === undefined) {
    return noReroute;
  }

  const candidates = routesFor(catalog.entries, entry).filter(
    (candidate) =>
      candidate.provider !== requested.provider &&
      (keys.has(candidate.provider) || subscribed.has(candidate.provider)),
  );

  if (candidates.length === 0) {
    const gatewayEntry = gatewayCoverage(catalog, entry, plan, hostedActive);
    if (gatewayEntry !== undefined) {
      return {
        model: gatewayEntry.id,
        provider: gatewayEntry.provider,
        rerouted: false,
        credential: "gateway",
      };
    }
    return noReroute;
  }

  const [chosen] = [...candidates].sort(byRoutePriority);

  return {
    model: chosen.id,
    provider: chosen.provider,
    rerouted: true,
    reason: PROVIDER_API_KEY_NAMES[requested.provider],
    credential: credentialFor(chosen.provider, subscribed),
  };
}

export function resolveSessionRoute(
  session: { model?: string; provider?: ModelProvider },
  catalog: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
  plan: Plan | null,
  configDir: string,
): ResolvedRoute {
  const defaults = resolveDefaultModel(configDir);
  const model = session.model ?? defaults.model;
  const provider = session.provider ?? defaults.provider ?? DEFAULT_PROVIDER;

  return resolveRoute(
    catalog,
    { model, provider },
    configured,
    effectiveHostedPlan(configDir, plan),
    subscribedProviders(configDir),
    hostedPlanUsable(configDir),
  );
}

export function resolveLegalReasoningTiers(route: ResolvedRoute, catalog: ModelCatalog): string[] {
  return legalTiersFor(findCatalogEntry(catalog, route.model, route.provider));
}
