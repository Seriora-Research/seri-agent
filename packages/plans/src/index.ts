

export const PLANS = ["free", "pro", "max", "ultra"] as const;
export type Plan = (typeof PLANS)[number];


export const PAID_PLANS = ["pro", "max", "ultra"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];



export const PLAN_MONTHLY_USD: Record<PaidPlan, number> = {
  pro: 20,
  max: 100,
  ultra: 200,
};

export const INCLUDED_SPEND_RATIO = 0.75;



export const SUBSCRIPTION_STATUSES = ["active", "canceled", "past_due", "revoked"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const PRODUCT_ENV_VAR: Record<Plan, string> = {
  free: "POLAR_PRODUCT_FREE",
  pro: "POLAR_PRODUCT_PRO",
  max: "POLAR_PRODUCT_MAX",
  ultra: "POLAR_PRODUCT_ULTRA",
};


export type ProductEnv = Record<string, string | undefined>;

export function isPaidPlan(value: unknown): value is PaidPlan {
  return typeof value === "string" && (PAID_PLANS as readonly string[]).includes(value);
}

export function toPlan(value: unknown): Plan | null {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value)
    ? (value as Plan)
    : null;
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


export function missingProductVars(env: ProductEnv): string[] {
  return Object.values(PRODUCT_ENV_VAR).filter((name) => !env[name]);
}

export {
  isQuotaExhaustedNotice,
  QUOTA_LIMITS,
  quotaExhaustedNotice,
  type QuotaLimit,
} from "./quotaNotice";
