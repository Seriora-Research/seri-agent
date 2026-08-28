import { describe, expect, test } from "bun:test";
import type { UsageReport } from "../../src/usage/report";
import { formatUsageReport, LOGGED_OUT_USAGE } from "../../src/usage/format";

const paid: UsageReport = {
  generatedAt: "2026-08-16T12:00:00.000Z",
  plan: "pro",
  window: {
    kind: "utc_month",
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-09-01T00:00:00.000Z",
  },
  quota: { metric: "usd", used: 5, included: 15, remaining: 10 },
  requestsToday: 3,
  dailyRequestCap: 500,
  hitAt: "2026-08-29T00:00:00.000Z",
  models: [
    {
      modelId: "openai/gpt-4o",
      costUsd: 4,
      requests: 2,
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 50,
      upstreamRoute: "/api/v1/chat/completions",
      share: 0.8,
    },
    {
      modelId: "other/model",
      costUsd: 1,
      requests: 1,
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 0,
      upstreamRoute: "/api/v1/chat/completions",
      share: 0.2,
    },
  ],
  cache: { inputTokens: 250, cacheReadTokens: 50, hitRate: 0.2 },
  days: [{ date: "2026-08-16", requests: 3, costUsd: 5 }],
  sessions: [
    { sessionId: "sess-1", requests: 2, costUsd: 4 },
    { sessionId: null, requests: 1, costUsd: 1 },
  ],
};

describe("formatUsageReport", () => {
  test("paid default view hides the upstream route and shows spend, reset, and pace", () => {
    const text = formatUsageReport(paid);
    expect(text).toContain("Hosted gateway  (Pro)");
    expect(text).toContain("Spend   $5.00 / $15.00  remaining $10.00");
    expect(text).toContain("Reset   2026-09-01");
    expect(text).toContain("At this pace you hit the cap on 2026-08-29.");
    expect(text).toContain("openai/gpt-4o  $4.00  (80%)");
    expect(text).not.toContain("/api/v1/chat/completions");
    expect(text).toContain("(unknown)");
  });

  test("--detail shows the upstream route", () => {
    const text = formatUsageReport(paid, { detail: true });
    expect(text).toContain("/api/v1/chat/completions");
  });

  test("stale snapshot is labeled", () => {
    const text = formatUsageReport(paid, { staleFrom: "2026-08-16T11:00:00.000Z" });
    expect(text.startsWith("Showing a snapshot from 2026-08-16T11:00:00.000Z.")).toBe(true);
  });

  test("cache dollar line is omitted without prices and present with them", () => {
    expect(formatUsageReport(paid)).toContain("Cache   20% hit");
    expect(formatUsageReport(paid)).not.toContain("saved");
    const pricey: UsageReport = {
      ...paid,
      models: [
        {
          ...paid.models[0]!,
          cacheReadTokens: 100_000,
        },
      ],
    };
    const withPrice = formatUsageReport(pricey, {
      cachePriceByModel: new Map([["openai/gpt-4o", { inputPerMTok: 5, cacheReadPerMTok: 0.5 }]]),
    });
    expect(withPrice).toContain("est. $0.45 saved");
  });

  test("logged-out copy names login and BYOK", () => {
    expect(LOGGED_OUT_USAGE).toContain("seri login");
    expect(LOGGED_OUT_USAGE).toContain("BYOK");
  });

  test("free view shows request quota, not spend", () => {
    const free: UsageReport = {
      ...paid,
      plan: "free",
      window: {
        kind: "utc_day",
        start: "2026-08-16T00:00:00.000Z",
        end: "2026-08-17T00:00:00.000Z",
      },
      quota: { metric: "requests", used: 2, included: 50, remaining: 48 },
      hitAt: null,
    };
    const text = formatUsageReport(free);
    expect(text).toContain("Requests  2 / 50  remaining 48");
    expect(text).not.toContain("Spend");
    expect(text).toContain("Reset   2026-08-17");
  });
});
