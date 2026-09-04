import { quotaExhaustedNotice, type QuotaLimit } from "@seri/plans";

import type { UsageReport } from "./report";

const QUOTA_CODES = {
  allowance_exhausted: "included_spend",
  free_daily_cap: "requests_today",
  paid_daily_cap: "requests_today",
} as const satisfies Record<string, QuotaLimit>;

const MS_PER_DAY = 86_400_000;

const UTC_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function utcResetLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${UTC_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} UTC`;
}

export function quotaResetIso(limit: QuotaLimit, now: Date): string {
  if (limit === "included_spend") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  }
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(start + MS_PER_DAY).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapError(err: unknown): unknown {
  const rec = asRecord(err);
  if (rec === null) return err;
  if (rec.lastError !== undefined) return rec.lastError;
  if (Array.isArray(rec.errors) && rec.errors.length > 0) return rec.errors[rec.errors.length - 1];
  return err;
}

function statusCodeOf(err: unknown): number | undefined {
  const rec = asRecord(err);
  return rec !== null && typeof rec.statusCode === "number" ? rec.statusCode : undefined;
}

function codeFromJsonBody(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const code = asRecord(parsed)?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function responseCodeOf(err: unknown): string | undefined {
  const rec = asRecord(err);
  if (rec === null) return undefined;
  if (typeof rec.responseBody === "string") {
    const code = codeFromJsonBody(rec.responseBody);
    if (code !== undefined) return code;
  }
  const dataCode = asRecord(rec.data)?.code;
  if (typeof dataCode === "string") return dataCode;
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  for (const code of Object.keys(QUOTA_CODES)) {
    if (text.includes(code)) return code;
  }
  return undefined;
}

export function quotaLimitFromError(err: unknown): QuotaLimit | null {
  const inner = unwrapError(err);
  if (statusCodeOf(inner) !== 402) return null;
  const code = responseCodeOf(inner);
  if (code === undefined) return null;
  return QUOTA_CODES[code as keyof typeof QUOTA_CODES] ?? null;
}

export function quotaLimitFromReport(report: UsageReport): QuotaLimit | null {
  if (report.plan === null) return null;
  if (report.quota.metric === "usd" && report.quota.remaining <= 0) return "included_spend";
  if (report.quota.metric === "requests" && report.quota.remaining <= 0) return "requests_today";
  if (report.dailyRequestCap > 0 && report.requestsToday >= report.dailyRequestCap) {
    return "requests_today";
  }
  return null;
}

export function quotaExhaustedLine(limit: QuotaLimit, now: Date = new Date()): string {
  return quotaExhaustedNotice(limit, utcResetLabel(quotaResetIso(limit, now)));
}

export function quotaExhaustedLineFromReport(report: UsageReport): string | null {
  const limit = quotaLimitFromReport(report);
  if (limit === null) return null;
  const iso =
    limit === "included_spend" || report.window.kind === "utc_day"
      ? report.window.end
      : quotaResetIso(limit, new Date(report.generatedAt));
  return quotaExhaustedNotice(limit, utcResetLabel(iso));
}

export function streamErrorText(err: unknown, fallback: (error: unknown) => string): string {
  const limit = quotaLimitFromError(err);
  return limit !== null ? quotaExhaustedLine(limit) : fallback(err);
}
