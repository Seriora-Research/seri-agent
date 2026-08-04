/*
 * The vocabulary of the `account_status` table, shared by its writer (the Polar webhook in
 * apps/server) and its reader (apps/portal).
 *
 * This is not the same situation as the two copies of `lib/supabase.ts`. If those drift,
 * one app is misconfigured — loud, immediate and local. If the plan mapping drifts, the
 * webhook writes a label the portal resolves to null, the portal's fast path misses on
 * every page load, the customer is shown a plan nobody recognizes, and not one test fails.
 * A silent divergence between the two ends of one column is what this package exists to
 * make impossible.
 */

export const PLANS = ["free", "pro", "max", "ultra"] as const;
export type Plan = (typeof PLANS)[number];

/*
 * The plans a request may ask for. "free" is absent on purpose: it is provisioned by API on
 * first login and never bought, and going back to it is a cancellation, which belongs to
 * Polar's customer portal.
 *
 * The order is ascending by price and `isUpgrade` depends on it. That dependency is not a
 * comment — PLAN_MONTHLY_USD is the same ladder as data, and a test asserts the two agree.
 */
export const PAID_PLANS = ["pro", "max", "ultra"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

// List price per month. Included upstream spend is 75% of it across the whole ladder — one
// rule, see docs-tmp/pricing-tiers.md.
export const PLAN_MONTHLY_USD: Record<PaidPlan, number> = {
  pro: 20,
  max: 100,
  ultra: 200,
};

export const INCLUDED_SPEND_RATIO = 0.75;

// The values written to account_status.subscription_status. Distinct from Polar's own
// vocabulary, which the webhook maps into this one.
export const SUBSCRIPTION_STATUSES = ["active", "canceled", "past_due", "revoked"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const PRODUCT_ENV_VAR: Record<Plan, string> = {
  free: "POLAR_PRODUCT_FREE",
  pro: "POLAR_PRODUCT_PRO",
  max: "POLAR_PRODUCT_MAX",
  ultra: "POLAR_PRODUCT_ULTRA",
};

/*
 * Product ids differ between the Polar sandbox and production, so they are configuration
 * rather than constants — and they are read through an injected record rather than
 * process.env so a test never has to set an environment variable to exercise the mapping.
 */
export type ProductEnv = Record<string, string | undefined>;

export function isPaidPlan(value: unknown): value is PaidPlan {
  return typeof value === "string" && (PAID_PLANS as readonly string[]).includes(value);
}

export function toPlan(value: unknown): Plan | null {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value) ? (value as Plan) : null;
}

export function toSubscriptionStatus(value: unknown): SubscriptionStatus | null {
  return typeof value === "string" && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
    ? (value as SubscriptionStatus)
    : null;
}

export function productIdForPlan(plan: Plan, env: ProductEnv): string | null {
  return env[PRODUCT_ENV_VAR[plan]] ?? null;
}

export function planForProductId(productId: string, env: ProductEnv): Plan | null {
  return PLANS.find((plan) => env[PRODUCT_ENV_VAR[plan]] === productId) ?? null;
}

export function isUpgrade(from: PaidPlan, to: PaidPlan): boolean {
  return PLAN_MONTHLY_USD[to] > PLAN_MONTHLY_USD[from];
}

/*
 * Which POLAR_PRODUCT_* variables a deployment is missing. What to do about it is the
 * caller's policy and deliberately not decided here: the webhook throws, because a 5xx
 * Polar retries beats writing a null plan into every row; the portal stays silent, because
 * a page render must not break on it.
 */
export function missingProductVars(env: ProductEnv): string[] {
  return Object.values(PRODUCT_ENV_VAR).filter((name) => !env[name]);
}
