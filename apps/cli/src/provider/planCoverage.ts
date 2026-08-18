import type { ModelCatalogEntry } from "@seri/model-catalog";
import { isPaidPlan, type Plan } from "@seri/plans";

// The same isZeroPriceModel predicate apps/server/lib/quota.ts:42-49 enforces server-side,
// re-derived here rather than imported since apps/cli cannot reach into apps/server/lib — keep
// the two in sync manually if Free-tier eligibility ever changes. A missing/unknown `pricing`
// is NOT zero-price — fail closed, same posture quota.ts's own comment states.
//
// Every paid plan reaches every model (pricing-tiers.md's "gate spend, not models" rule), so
// coverage there needs no pricing check at all.
export function planCoverage(entry: ModelCatalogEntry, plan: Plan | null): boolean {
  if (plan === null) return false;
  if (isPaidPlan(plan)) return true;
  return (
    entry.pricing !== undefined &&
    entry.pricing.inputPerMTok === 0 &&
    entry.pricing.outputPerMTok === 0
  );
}
