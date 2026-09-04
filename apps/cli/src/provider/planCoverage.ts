import { isZeroPriceEntry, type ModelCatalogEntry } from "@seri/model-catalog";
import { isPaidPlan, type Plan } from "@seri/plans";

export { GATEWAY_PROVIDER } from "@seri/model-catalog";

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
