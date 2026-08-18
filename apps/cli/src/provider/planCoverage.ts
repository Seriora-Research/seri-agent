import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import { isPaidPlan, type Plan } from "@seri/plans";

// The only provider apps/server's gateway route currently forwards to — apps/server/lib/quota.ts's
// own isZeroPriceModel always resolves pricing via findCatalogEntry(catalog, modelId, "openrouter"),
// and the chat/completions route's upstream fetch is hardcoded to OpenRouter's endpoint. ONE named
// export so a future second gateway-backed provider is a one-place change in apps/cli, not a
// scattered string comparison; apps/server's own "openrouter" literals should switch to importing
// an equivalent constant when a second provider is actually wired there — out of scope here.
export const GATEWAY_PROVIDER: ModelProvider = "openrouter";

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
