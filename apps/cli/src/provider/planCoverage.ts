import { isZeroPriceEntry, type ModelCatalogEntry } from "@seri/model-catalog";
import { isPaidPlan, type Plan } from "@seri/plans";

export { GATEWAY_PROVIDER } from "@seri/model-catalog";

export function planCoverage(entry: ModelCatalogEntry, plan: Plan | null): boolean {
  if (plan === null) return false;
  if (isPaidPlan(plan)) return true;
  return isZeroPriceEntry(entry);
}
