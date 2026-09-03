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
      cacheWriteTokens: 10,
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
      cacheWriteTokens: 0,
      upstreamRoute: "/api/v1/chat/completions",
      share: 0.2,
    },
  ],
  cache: {
    inputTokens: 250,
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
    hitRate: 0.2,
    writeRate: 0.04,
  },
  days: [
    {
      date: "2026-08-16",
      requests: 3,
      costUsd: 5,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
    },
  ],
  sessions: [
    { sessionId: "sess-1", requests: 2, costUsd: 4 },
    { sessionId: null, requests: 1, costUsd: 1 },
  ],
};

describe("formatUsageReport", () => {
  test("paid default view leads with percent of included and hides the upstream route", () => {
    const text = formatUsageReport(paid);
    expect(text).toContain("Hosted  Pro");
    expect(text).toContain("Included this month");
    expect(text).toContain("33% used");
    expect(text).toContain("$5.00 of $15.00");
    expect(text).toContain("resets 1 Sep 2026 UTC");
    expect(text).toContain("At this pace you hit the cap on 2026-08-29.");
    expect(text).toContain("openai/gpt-4o");
    expect(text).toContain("50 cache read");
    expect(text).toContain("10 cache write");
    expect(text).toContain("80%");
    expect(text).not.toContain("/api/v1/chat/completions");
    expect(text).not.toContain("Spend   $5.00");
    expect(text).not.toContain("saved");
  });

  test("--detail shows the upstream route on the same model lines", () => {
    const text = formatUsageReport(paid, { detail: true });
    expect(text).toContain("/api/v1/chat/completions");
    expect(text).toContain("Included this month");
  });

  test("stale snapshot is labeled", () => {
    const text = formatUsageReport(paid, { staleFrom: "2026-08-16T11:00:00.000Z" });
    expect(text.startsWith("Showing a snapshot from 2026-08-16T11:00:00.000Z.")).toBe(true);
  });

  test("cache block names hit rate, read, and write", () => {
    const text = formatUsageReport(paid);
    expect(text).toContain("Cache");
    expect(text).toContain("20% of input from cache");
    expect(text).toContain("50 read");
    expect(text).toContain("10 written");
    expect(text).not.toContain("est. $");
  });

  test("logged-out copy names login and BYOK", () => {
    expect(LOGGED_OUT_USAGE).toContain("/login");
    expect(LOGGED_OUT_USAGE).toContain("BYOK");
  });

  test("free view shows request percent, not a spend meter", () => {
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
    expect(text).toContain("Requests today");
    expect(text).toContain("4% used");
    expect(text).toContain("2 of 50");
    expect(text).toContain("resets 17 Aug 2026 UTC");
    expect(text).not.toContain("Included this month");
    expect(text).not.toContain("$5.00 of $15.00");
  });
});
