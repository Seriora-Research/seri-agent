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
    cacheWriteTokens: number;
    upstreamRoute: string;
    share: number;
  }>;
  cache: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    hitRate: number;
    writeRate: number;
  };
  days: Array<{
    date: string;
    requests: number;
    costUsd: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
  sessions: Array<{ sessionId: string | null; requests: number; costUsd: number }>;
};

function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isModel(value: unknown): value is UsageReport["models"][number] {
  if (!isRecord(value)) return false;
  return (
    typeof value.modelId === "string" &&
    isFiniteNumber(value.costUsd) &&
    isFiniteNumber(value.requests) &&
    isFiniteNumber(value.inputTokens) &&
    isFiniteNumber(value.outputTokens) &&
    isFiniteNumber(value.cacheReadTokens) &&
    isFiniteNumber(value.cacheWriteTokens) &&
    typeof value.upstreamRoute === "string" &&
    isFiniteNumber(value.share)
  );
}

function isWindow(value: unknown): value is UsageReport["window"] {
  if (!isRecord(value)) return false;
  return (
    (value.kind === "utc_day" || value.kind === "utc_month") &&
    typeof value.start === "string" &&
    typeof value.end === "string"
  );
}

function isQuota(value: unknown): value is UsageReport["quota"] {
  if (!isRecord(value)) return false;
  return (
    (value.metric === "requests" || value.metric === "usd") &&
    isFiniteNumber(value.used) &&
    isFiniteNumber(value.included) &&
    isFiniteNumber(value.remaining)
  );
}

function isCache(value: unknown): value is UsageReport["cache"] {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.inputTokens) &&
    isFiniteNumber(value.cacheReadTokens) &&
    isFiniteNumber(value.cacheWriteTokens) &&
    isFiniteNumber(value.hitRate) &&
    isFiniteNumber(value.writeRate)
  );
}

function isDay(value: unknown): value is UsageReport["days"][number] {
  if (!isRecord(value)) return false;
  return (
    typeof value.date === "string" &&
    isFiniteNumber(value.requests) &&
    isFiniteNumber(value.costUsd) &&
    isFiniteNumber(value.cacheReadTokens) &&
    isFiniteNumber(value.cacheWriteTokens)
  );
}

function isSession(value: unknown): value is UsageReport["sessions"][number] {
  if (!isRecord(value)) return false;
  return (
    (value.sessionId === null || typeof value.sessionId === "string") &&
    isFiniteNumber(value.requests) &&
    isFiniteNumber(value.costUsd)
  );
}

export function parseUsageReport(body: unknown): UsageReport | null {
  if (!isRecord(body)) return null;
  if (typeof body.generatedAt !== "string") return null;
  if (body.plan !== null && !isPlan(body.plan)) return null;
  if (!isWindow(body.window)) return null;
  if (!isQuota(body.quota)) return null;
  if (!isFiniteNumber(body.requestsToday) || !isFiniteNumber(body.dailyRequestCap)) return null;
  if (body.hitAt !== null && typeof body.hitAt !== "string") return null;
  if (!Array.isArray(body.models) || !body.models.every(isModel)) return null;
  if (!isCache(body.cache)) return null;
  if (!Array.isArray(body.days) || !body.days.every(isDay)) return null;
  if (!Array.isArray(body.sessions) || !body.sessions.every(isSession)) return null;
  return body as UsageReport;
}
