import type { UsageReport } from "./report";

export type FormatUsageOpts = {
  detail?: boolean;
  staleFrom?: string;
};

export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function quotaUsedShare(used: number, included: number): number {
  if (included <= 0) return 0;
  return Math.min(1, Math.max(0, used / included));
}

export function meterBar(share: number, width = 24): string {
  const w = Math.max(8, Math.min(40, Math.floor(width)));
  const fill = Math.round(quotaUsedShare(share, 1) * w);
  return `[${"█".repeat(fill)}${"-".repeat(w - fill)}]`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

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

function resetLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${UTC_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} UTC`;
}

function paceLine(report: UsageReport): string {
  if (report.quota.used <= 0) return "Pace  Nothing recorded this window.";
  if (report.quota.remaining <= 0) return "Pace  Allowance already exhausted this window.";
  if (report.hitAt === null) return "Pace  At this rate you stay under the cap.";
  return `Pace  At this pace you hit the cap on ${dateOnly(report.hitAt)}.`;
}

function modelLine(model: UsageReport["models"][number], detail: boolean): string {
  const route = detail ? `  ${model.upstreamRoute}` : "";
  return `  ${model.modelId}  ${formatTokenCount(model.inputTokens)} in  ${formatTokenCount(model.outputTokens)} out  ${formatTokenCount(model.cacheReadTokens)} cache read  ${formatTokenCount(model.cacheWriteTokens)} cache write  ${formatShare(model.share)}${route}`;
}

export const LOGGED_OUT_USAGE = `Not signed in. /usage shows hosted-gateway spend for a seri account.
Sign in with /login.
BYOK provider-key spend is in your provider console, not here.`;

export function usagePanelLines(report: UsageReport, opts: FormatUsageOpts = {}): string[] {
  const lines: string[] = [];
  if (opts.staleFrom !== undefined) {
    lines.push(`Showing a snapshot from ${opts.staleFrom}. Figures may be stale.`);
    lines.push("");
  }

  if (report.plan === null) {
    lines.push("No hosted plan yet. The first gateway request provisions Free.");
    return lines;
  }

  const planLabel = report.plan[0]?.toUpperCase() + report.plan.slice(1);
  lines.push(`Hosted  ${planLabel}`);
  lines.push("");

  const share = quotaUsedShare(report.quota.used, report.quota.included);
  if (report.quota.metric === "usd") {
    lines.push("Included this month");
    lines.push(`${meterBar(share)}  ${formatShare(share)} used`);
    lines.push(
      `${usd(report.quota.used)} of ${usd(report.quota.included)}  resets ${resetLabel(report.window.end)}`,
    );
    lines.push(paceLine(report));
    lines.push("");
    lines.push("Requests today");
    lines.push(
      `${meterBar(quotaUsedShare(report.requestsToday, report.dailyRequestCap))}  ${report.requestsToday} / ${report.dailyRequestCap}`,
    );
  } else {
    lines.push("Requests today");
    lines.push(`${meterBar(share)}  ${formatShare(share)} used`);
    lines.push(
      `${report.quota.used} of ${report.quota.included}  resets ${resetLabel(report.window.end)}`,
    );
    lines.push(paceLine(report));
  }

  if (report.models.length > 0) {
    lines.push("");
    lines.push("By model");
    for (const model of report.models) {
      lines.push(modelLine(model, opts.detail === true));
    }
  }

  if (report.cache.inputTokens > 0) {
    lines.push("");
    lines.push("Cache");
    lines.push(
      `  ${formatShare(report.cache.hitRate)} of input from cache  ·  ${formatTokenCount(report.cache.cacheReadTokens)} read  ·  ${formatTokenCount(report.cache.cacheWriteTokens)} written`,
    );
  }

  return lines;
}

export function formatUsageReport(report: UsageReport, opts: FormatUsageOpts = {}): string {
  return usagePanelLines(report, opts).join("\n");
}
