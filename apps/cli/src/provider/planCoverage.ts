import { isZeroPriceEntry, type ModelCatalogEntry, type ModelProvider } from "@seri/model-catalog";
import { isPaidPlan, type Plan } from "@seri/plans";

// The only provider apps/server's gateway route currently forwards to — apps/server/lib/quota.ts's
// own isZeroPriceModel always resolves pricing via findCatalogEntry(catalog, modelId, "openrouter"),
// and the chat/completions route's upstream fetch is hardcoded to OpenRouter's endpoint. ONE named
// export so a future second gateway-backed provider is a one-place change in apps/cli, not a
// scattered string comparison; apps/server's own "openrouter" literals should switch to importing
// an equivalent constant when a second provider is actually wired there — out of scope here.
export const GATEWAY_PROVIDER: ModelProvider = "openrouter";

// isZeroPriceEntry is the same predicate apps/server/lib/quota.ts's own isZeroPriceModel enforces
// server-side, shared via @seri/model-catalog rather than re-derived by hand — both apps already
// depend on that package for ModelCatalogEntry itself.
//
// Every paid plan reaches every model (pricing-tiers.md's "gate spend, not models" rule), so
// coverage there needs no pricing check at all.
export function planCoverage(entry: ModelCatalogEntry, plan: Plan | null): boolean {
  if (plan === null) return false;
  if (isPaidPlan(plan)) return true;
  return isZeroPriceEntry(entry);
}
