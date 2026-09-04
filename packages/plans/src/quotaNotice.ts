export const QUOTA_LIMITS = ["included_spend", "requests_today"] as const;
export type QuotaLimit = (typeof QUOTA_LIMITS)[number];

const HIT: Record<QuotaLimit, string> = {
  included_spend: "Included spend this month is used up",
  requests_today: "Requests today are used up",
};

export function quotaExhaustedNotice(limit: QuotaLimit, resetLabel: string): string {
  return `${HIT[limit]}. Hosted routes will not run until ${resetLabel}.`;
}

export function isQuotaExhaustedNotice(text: string): boolean {
  return (
    (text.startsWith(`${HIT.included_spend}.`) || text.startsWith(`${HIT.requests_today}.`)) &&
    text.includes("Hosted routes will not run until")
  );
}
