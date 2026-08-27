import { type Plan, PLANS } from "@seri/plans";

export type UsageReport = {
  generatedAt: string;
  plan: Plan | null;
  window: { kind: "utc_day" | "utc_month"; start: string; end: string };
  quota: {
    metric: "requests" | "usd";
    used: number;
    included: number;
    remaining: number;
  };
  requestsToday: number;
  dailyRequestCap: number;
  hitAt: string | null;
  models: Array<{
    modelId: string;
    costUsd: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    upstreamRoute: string;
    share: number;
  }>;
  cache: { inputTokens: number; cacheReadTokens: number; hitRate: number };
  days: Array<{ date: string; requests: number; costUsd: number }>;
  sessions: Array<{ sessionId: string | null; requests: number; costUsd: number }>;
};

function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isModel(value: unknown): value is UsageReport["models"][number] {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.modelId === "string" &&
    isFiniteNumber(row.costUsd) &&
    isFiniteNumber(row.requests) &&
    isFiniteNumber(row.inputTokens) &&
    isFiniteNumber(row.outputTokens) &&
    isFiniteNumber(row.cacheReadTokens) &&
    typeof row.upstreamRoute === "string" &&
    isFiniteNumber(row.share)
  );
}

export function parseUsageReport(body: unknown): UsageReport | null {
  if (body === null || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.generatedAt !== "string") return null;
  if (o.plan !== null && !isPlan(o.plan)) return null;
  const window = o.window as Record<string, unknown> | undefined;
  if (
    window === undefined ||
    (window.kind !== "utc_day" && window.kind !== "utc_month") ||
    typeof window.start !== "string" ||
    typeof window.end !== "string"
  ) {
    return null;
  }
  const quota = o.quota as Record<string, unknown> | undefined;
  if (
    quota === undefined ||
    (quota.metric !== "requests" && quota.metric !== "usd") ||
    !isFiniteNumber(quota.used) ||
    !isFiniteNumber(quota.included) ||
    !isFiniteNumber(quota.remaining)
  ) {
    return null;
  }
  if (!isFiniteNumber(o.requestsToday) || !isFiniteNumber(o.dailyRequestCap)) return null;
  if (o.hitAt !== null && typeof o.hitAt !== "string") return null;
  if (!Array.isArray(o.models) || !o.models.every(isModel)) return null;
  const cache = o.cache as Record<string, unknown> | undefined;
  if (
    cache === undefined ||
    !isFiniteNumber(cache.inputTokens) ||
    !isFiniteNumber(cache.cacheReadTokens) ||
    !isFiniteNumber(cache.hitRate)
  ) {
    return null;
  }
  if (!Array.isArray(o.days) || !Array.isArray(o.sessions)) return null;
  return o as UsageReport;
}
