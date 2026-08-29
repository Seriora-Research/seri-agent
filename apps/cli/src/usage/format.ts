import type { UsageReport } from "./report";

export type CachePrice = { inputPerMTok: number; cacheReadPerMTok: number };

export type FormatUsageOpts = {
  detail?: boolean;
  staleFrom?: string;
  cachePriceByModel?: ReadonlyMap<string, CachePrice>;
};

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function estimatedCacheSavedUsd(
  report: UsageReport,
  prices: ReadonlyMap<string, CachePrice> | undefined,
): number | undefined {
  if (prices === undefined || prices.size === 0) return undefined;
  let saved = 0;
  let priced = false;
  for (const model of report.models) {
    const price = prices.get(model.modelId);
    if (price === undefined) continue;
    priced = true;
    saved += (model.cacheReadTokens * (price.inputPerMTok - price.cacheReadPerMTok)) / 1_000_000;
  }
  return priced ? saved : undefined;
}

export const LOGGED_OUT_USAGE = `Not signed in. /usage shows hosted-gateway spend for a seri account.
Sign in with /login.
BYOK provider-key spend is in your provider console, not here.`;

export function formatUsageReport(report: UsageReport, opts: FormatUsageOpts = {}): string {
  const lines: string[] = [];
  if (opts.staleFrom !== undefined) {
    lines.push(
      `Showing a snapshot from ${opts.staleFrom}. Figures may be stale. Retry: /usage`,
      "",
    );
  }

  if (report.plan === null) {
    lines.push("No hosted plan yet. The first gateway request provisions Free.");
    return lines.join("\n");
  }

  const planLabel = report.plan[0]?.toUpperCase() + report.plan.slice(1);
  lines.push(`Hosted gateway  (${planLabel})`);
  lines.push(`Window  ${dateOnly(report.window.start)} → ${dateOnly(report.window.end)} UTC`);

  if (report.quota.metric === "usd") {
    lines.push(
      `Spend   ${usd(report.quota.used)} / ${usd(report.quota.included)}  remaining ${usd(report.quota.remaining)}`,
    );
  } else {
    lines.push(
      `Requests  ${report.quota.used} / ${report.quota.included}  remaining ${report.quota.remaining}`,
    );
  }
  lines.push(`Reset   ${dateOnly(report.window.end)}`);

  if (report.quota.used <= 0) {
    lines.push("Pace    Nothing recorded this window.");
  } else if (report.quota.remaining <= 0) {
    lines.push("Pace    Allowance already exhausted this window.");
  } else if (report.hitAt === null) {
    lines.push("Pace    At this pace you stay under the cap this period.");
  } else {
    lines.push(`Pace    At this pace you hit the cap on ${dateOnly(report.hitAt)}.`);
  }

  if (report.quota.metric === "usd") {
    lines.push(`Requests today  ${report.requestsToday} / ${report.dailyRequestCap}`);
  }

  if (report.models.length > 0) {
    lines.push("", "Models");
    for (const model of report.models) {
      const route = opts.detail === true ? `  ${model.upstreamRoute}` : "";
      const amount = report.quota.metric === "usd" ? usd(model.costUsd) : `${model.requests} req`;
      lines.push(`  ${model.modelId}  ${amount}  (${pct(model.share)})${route}`);
    }
  }

  if (report.cache.inputTokens > 0) {
    const hit = pct(report.cache.hitRate);
    const saved = estimatedCacheSavedUsd(report, opts.cachePriceByModel);
    const savedBit = saved === undefined ? "" : `  (est. ${usd(saved)} saved)`;
    lines.push("", `Cache   ${hit} hit${savedBit}`);
  }

  if (report.days.length > 0) {
    lines.push("", "Days");
    for (const day of report.days) {
      lines.push(`  ${day.date}  ${usd(day.costUsd)}  ${day.requests} req`);
    }
  }

  if (report.sessions.length > 0) {
    lines.push("", "Sessions");
    for (const session of report.sessions) {
      const id = session.sessionId ?? "(unknown)";
      lines.push(`  ${id}  ${usd(session.costUsd)}  ${session.requests} req`);
    }
  }

  return lines.join("\n");
}
