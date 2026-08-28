import { describe, expect, test } from "bun:test";
import { parseUsageReport } from "../../src/usage/report";

function validBody(): Record<string, unknown> {
  return {
    generatedAt: "2026-08-16T12:00:00.000Z",
    plan: "pro",
    window: {
      kind: "utc_month",
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-09-01T00:00:00.000Z",
    },
    quota: { metric: "usd", used: 1, included: 15, remaining: 14 },
    requestsToday: 1,
    dailyRequestCap: 500,
    hitAt: null,
    models: [],
    cache: { inputTokens: 0, cacheReadTokens: 0, hitRate: 0 },
    days: [{ date: "2026-08-16", requests: 1, costUsd: 1 }],
    sessions: [{ sessionId: null, requests: 1, costUsd: 1 }],
  };
}

describe("parseUsageReport", () => {
  test("accepts a well-formed report", () => {
    expect(parseUsageReport(validBody())).not.toBeNull();
  });

  test("null window, quota, or cache returns null instead of throwing", () => {
    expect(parseUsageReport({ ...validBody(), window: null })).toBeNull();
    expect(parseUsageReport({ ...validBody(), quota: null })).toBeNull();
    expect(parseUsageReport({ ...validBody(), cache: null })).toBeNull();
  });

  test("malformed days or sessions rows return null", () => {
    expect(
      parseUsageReport({ ...validBody(), days: [{ date: 1, requests: 1, costUsd: 1 }] }),
    ).toBeNull();
    expect(
      parseUsageReport({
        ...validBody(),
        sessions: [{ sessionId: 1, requests: 1, costUsd: 1 }],
      }),
    ).toBeNull();
  });
});
