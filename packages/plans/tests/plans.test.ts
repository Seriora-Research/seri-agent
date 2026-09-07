import { describe, expect, test } from "bun:test";
import {
  PAID_PLANS,
  PLANS,
  PLAN_MONTHLY_USD,
  SUBSCRIPTION_STATUSES,
  isPaidPlan,
  isQuotaExhaustedNotice,
  isUpgrade,
  missingProductVars,
  planForProductId,
  productIdForPlan,
  quotaExhaustedNotice,
  toPlan,
  toSubscriptionStatus,
} from "../src/index";

const ENV = {
  POLAR_PRODUCT_FREE: "prod_free",
  POLAR_PRODUCT_PRO: "prod_pro",
  POLAR_PRODUCT_MAX: "prod_max",
  POLAR_PRODUCT_ULTRA: "prod_ultra",
};

describe("productIdForPlan / planForProductId", () => {
  for (const plan of PLANS) {
    test(`round-trips ${plan} through the injected env record`, () => {
      const productId = productIdForPlan(plan, ENV);
      expect(productId).toBe(`prod_${plan}`);
      expect(planForProductId(productId!, ENV)).toBe(plan);
    });
  }

  test("returns null for a product id that is not configured", () => {
    expect(planForProductId("prod_from_the_other_environment", ENV)).toBeNull();
  });



  test("returns null for every plan when nothing is configured", () => {
    for (const plan of PLANS) expect(productIdForPlan(plan, {})).toBeNull();
    expect(planForProductId("prod_free", {})).toBeNull();
  });
});

describe("isPaidPlan", () => {
  test("excludes free, so /api/checkout and /api/plan can never resolve the free product", () => {
    expect(isPaidPlan("free")).toBe(false);
  });

  test.each(["pro", "max", "ultra"])("accepts %s", (plan) => {
    expect(isPaidPlan(plan)).toBe(true);
  });

  test.each(["", "FREE", "enterprise", null, 1, { plan: "pro" }])("rejects %p", (value) => {
    expect(isPaidPlan(value)).toBe(false);
  });
});

describe("toPlan", () => {
  for (const plan of PLANS) {
    test(`accepts the stored label ${plan}`, () => {
      expect(toPlan(plan)).toBe(plan);
    });
  }

  test.each([null, undefined, "", "gold", 3])(
    "maps the unrecognized column value %p to null",
    (value) => {
      expect(toPlan(value)).toBeNull();
    },
  );
});

describe("toSubscriptionStatus", () => {
  for (const status of SUBSCRIPTION_STATUSES) {
    test(`accepts the stored status ${status}`, () => {
      expect(toSubscriptionStatus(status)).toBe(status);
    });
  }



  test.each([null, undefined, "", "trialing", "incomplete", 1])("maps %p to null", (value) => {
    expect(toSubscriptionStatus(value)).toBeNull();
  });
});

describe("isUpgrade", () => {

  test("PAID_PLANS is ordered by ascending price", () => {
    const prices = PAID_PLANS.map((plan) => PLAN_MONTHLY_USD[plan]);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  test.each([
    ["pro", "max"],
    ["pro", "ultra"],
    ["max", "ultra"],
  ] as const)("%s -> %s is an upgrade", (from, to) => {
    expect(isUpgrade(from, to)).toBe(true);
  });

  test.each([
    ["max", "pro"],
    ["ultra", "pro"],
    ["ultra", "max"],
  ] as const)("%s -> %s is not an upgrade", (from, to) => {
    expect(isUpgrade(from, to)).toBe(false);
  });



  for (const plan of PAID_PLANS) {
    test(`${plan} -> itself is not an upgrade`, () => {
      expect(isUpgrade(plan, plan)).toBe(false);
    });
  }
});

describe("missingProductVars", () => {
  test("names every variable when nothing is configured", () => {
    expect(missingProductVars({})).toEqual([
      "POLAR_PRODUCT_FREE",
      "POLAR_PRODUCT_PRO",
      "POLAR_PRODUCT_MAX",
      "POLAR_PRODUCT_ULTRA",
    ]);
  });

  test("names only the ones that are missing", () => {
    expect(
      missingProductVars({ POLAR_PRODUCT_FREE: "prod_free", POLAR_PRODUCT_PRO: "prod_pro" }),
    ).toEqual(["POLAR_PRODUCT_MAX", "POLAR_PRODUCT_ULTRA"]);
  });

  test("is empty when the deployment is fully configured", () => {
    expect(missingProductVars(ENV)).toEqual([]);
  });
});

describe("quotaExhaustedNotice", () => {
  test("names the spend cap and the reset instant", () => {
    expect(quotaExhaustedNotice("included_spend", "1 Oct 2026 UTC")).toBe(
      "Included spend this month is used up. Hosted routes will not run until 1 Oct 2026 UTC.",
    );
  });

  test("names the daily request cap and the reset instant", () => {
    expect(quotaExhaustedNotice("requests_today", "5 Sep 2026 UTC")).toBe(
      "Requests today are used up. Hosted routes will not run until 5 Sep 2026 UTC.",
    );
  });

  test("isQuotaExhaustedNotice accepts only those two sentences", () => {
    const spend = quotaExhaustedNotice("included_spend", "1 Oct 2026 UTC");
    expect(isQuotaExhaustedNotice(spend)).toBe(true);
    expect(
      isQuotaExhaustedNotice(
        "Requests today are used up. Hosted routes will not run until 5 Sep 2026 UTC.",
      ),
    ).toBe(true);
    expect(isQuotaExhaustedNotice("At the cap this period. Resets 1 Oct 2026 UTC.")).toBe(false);
    expect(isQuotaExhaustedNotice("AI_APICallError: Payment Required")).toBe(false);
  });
});
