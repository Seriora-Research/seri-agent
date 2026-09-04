import { APICallError } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import { quotaExhaustedNotice } from "@seri/plans";

import {
  quotaExhaustedLine,
  quotaExhaustedLineFromReport,
  quotaLimitFromError,
  quotaLimitFromReport,
  quotaResetIso,
  utcResetLabel,
} from "../../src/usage/quotaNotice";
import type { UsageReport } from "../../src/usage/report";

const paid: UsageReport = {
  generatedAt: "2026-09-04T12:00:00.000Z",
  plan: "pro",
  window: {
    kind: "utc_month",
    start: "2026-09-01T00:00:00.000Z",
    end: "2026-10-01T00:00:00.000Z",
  },
  quota: { metric: "usd", used: 5, included: 15, remaining: 10 },
  requestsToday: 3,
  dailyRequestCap: 500,
  hitAt: null,
  models: [],
  cache: {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    hitRate: 0,
    writeRate: 0,
  },
  days: [],
  sessions: [],
};

function quotaError(code: string, statusCode = 402): APICallError {
  return new APICallError({
    message: "Payment Required",
    url: "https://api.seriora.ai/api/gateway/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify({ code }),
  });
}

describe("quotaLimitFromError", () => {
  test("maps hosted cap codes and ignores other 402s", () => {
    expect(quotaLimitFromError(quotaError("allowance_exhausted"))).toBe("included_spend");
    expect(quotaLimitFromError(quotaError("free_daily_cap"))).toBe("requests_today");
    expect(quotaLimitFromError(quotaError("paid_daily_cap"))).toBe("requests_today");
    expect(quotaLimitFromError(quotaError("unknown_plan"))).toBeNull();
    expect(quotaLimitFromError(quotaError("model_not_in_free_tier"))).toBeNull();
    expect(quotaLimitFromError(quotaError("allowance_exhausted", 429))).toBeNull();
  });

  test("reads the last error of a wrapped retry", () => {
    const wrapped = {
      lastError: quotaError("free_daily_cap"),
      statusCode: 402,
    };
    expect(quotaLimitFromError(wrapped)).toBe("requests_today");
  });
});

describe("quotaLimitFromReport", () => {
  test("spend remaining zero is included spend", () => {
    expect(
      quotaLimitFromReport({
        ...paid,
        quota: { metric: "usd", used: 15, included: 15, remaining: 0 },
      }),
    ).toBe("included_spend");
  });

  test("paid daily request cap is requests today even when spend remains", () => {
    expect(
      quotaLimitFromReport({
        ...paid,
        requestsToday: 500,
        dailyRequestCap: 500,
      }),
    ).toBe("requests_today");
  });

  test("free remaining zero is requests today", () => {
    expect(
      quotaLimitFromReport({
        ...paid,
        plan: "free",
        window: {
          kind: "utc_day",
          start: "2026-09-04T00:00:00.000Z",
          end: "2026-09-05T00:00:00.000Z",
        },
        quota: { metric: "requests", used: 50, included: 50, remaining: 0 },
      }),
    ).toBe("requests_today");
  });

  test("under the cap is null", () => {
    expect(quotaLimitFromReport(paid)).toBeNull();
  });
});

describe("quotaExhaustedLine", () => {
  test("computes the month reset from now for included spend", () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(quotaExhaustedLine("included_spend", now)).toBe(
      quotaExhaustedNotice("included_spend", "1 Oct 2026 UTC"),
    );
    expect(quotaResetIso("included_spend", now)).toBe("2026-10-01T00:00:00.000Z");
  });

  test("computes the next UTC day for requests today", () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(quotaExhaustedLine("requests_today", now)).toBe(
      quotaExhaustedNotice("requests_today", "5 Sep 2026 UTC"),
    );
    expect(utcResetLabel("2026-09-05T00:00:00.000Z")).toBe("5 Sep 2026 UTC");
  });

  test("paid daily cap uses the day end, not the month window", () => {
    const line = quotaExhaustedLineFromReport({
      ...paid,
      requestsToday: 500,
      dailyRequestCap: 500,
    });
    expect(line).toBe(quotaExhaustedNotice("requests_today", "5 Sep 2026 UTC"));
    expect(line).not.toContain("1 Oct 2026");
  });

  test("paid spend cap uses the report window end", () => {
    expect(
      quotaExhaustedLineFromReport({
        ...paid,
        quota: { metric: "usd", used: 15, included: 15, remaining: 0 },
      }),
    ).toBe(quotaExhaustedNotice("included_spend", "1 Oct 2026 UTC"));
  });
});
