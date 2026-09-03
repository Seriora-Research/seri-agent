import { parseResponseBody } from "./deviceGrant";
import type { RefreshSubscription, SubscriptionCredential } from "./subscription";
import {
  loadXaiSubscription,
  saveXaiSubscription,
  subscriptionFromTokens,
  type XaiSubscription,
} from "./xaiAuthStore";
import { discoverXaiEndpoints, readXaiTokens, xaiClientId, xaiIssuer } from "./xaiOAuth";

export type XaiRefreshResult =
  | { status: "ok"; subscription: XaiSubscription }
  | { status: "not-connected" }
  // Terminal. A 403 means the account's plan tier is not allowed, which no retry and no
  // re-consent fixes. Kept distinct from "error" so a caller cannot fold it into a retry loop.
  | { status: "tier-denied"; message: string }
  // The stored refresh token is dead — the usual cause is a rotation that was lost, since xAI
  // invalidates the previous token on every use. Terminal and distinct from "error": no retry
  // recovers it, the only fix is connecting again, so a caller must say that rather than loop.
  | { status: "reconnect-required"; message: string }
  | { status: "error"; message: string };

// Same hazard, same shape as auth/refresh.ts's own map, for the same reason: two concurrent 401s
// (a subagent fan-out against one model is the real source) can each read the same on-disk refresh
// token before either submits it. xAI accepts a rotating refresh token exactly once, so the loser
// would strand its caller even though a valid rotated pair now exists on disk. One in-flight
// promise per configDir makes every concurrent caller share one refresh.
const inFlightRefreshes = new Map<string, Promise<XaiRefreshResult>>();

export function refreshXaiSubscription(
  configDir: string,
  fetchFn: typeof fetch = fetch,
): Promise<XaiRefreshResult> {
  const existing = inFlightRefreshes.get(configDir);
  if (existing) return existing;

  const promise = refreshXaiSubscriptionOnce(configDir, fetchFn);
  inFlightRefreshes.set(configDir, promise);
  // .finally() returns a NEW promise that also rejects when `promise` does; discarding it uncaught
  // would be a second unhandled rejection on top of the one the caller already handles. The
  // .catch here is only for this derived promise.
  promise.finally(() => inFlightRefreshes.delete(configDir)).catch(() => {});
  return promise;
}

async function refreshXaiSubscriptionOnce(
  configDir: string,
  fetchFn: typeof fetch,
): Promise<XaiRefreshResult> {
  const clientId = xaiClientId(configDir);
  const current = loadXaiSubscription(configDir);
  if (current === undefined) return { status: "not-connected" };

  try {
    const endpoints = await discoverXaiEndpoints(xaiIssuer(configDir), fetchFn);
    const response = await fetchFn(endpoints.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: current.refreshToken,
      }).toString(),
    });
    const payload = await parseResponseBody(response);

    if (response.status === 403) {
      return {
        status: "tier-denied",
        message: String(payload.error_description ?? payload.error ?? "Plan tier not allowed"),
      };
    }
    if (payload.error === "invalid_grant") {
      return {
        status: "reconnect-required",
        message: "Your Grok subscription session has expired. Connect it again from /setup.",
      };
    }
    if (!response.ok) {
      return {
        status: "error",
        message: `xAI refresh failed: ${payload.error ?? response.status}`,
      };
    }

    // readXaiTokens throws unless BOTH tokens came back. Persisting a partial pair here is the one
    // failure that cannot be recovered from: the old refresh token is already dead server-side.
    const updated = subscriptionFromTokens({
      ...readXaiTokens(payload),
      accountId: current.accountId,
    });
    saveXaiSubscription(updated, configDir);
    return { status: "ok", subscription: updated };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

// The xAI counterpart to provider/authedFetch.ts: attach the bearer, refresh once on 401, retry.
// A 403 is returned untouched and never refreshed — it is the terminal tier-denied case, and
// retrying it would burn a refresh token to no effect.
export function xaiAuthedFetch(configDir: string, fetchFn: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const attempt = async (token: string): Promise<Response> =>
      fetchFn(input, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          authorization: `Bearer ${token}`,
        },
      });

    const current = loadXaiSubscription(configDir);
    if (current === undefined) {
      throw new Error("No Grok subscription is connected. Run /setup to connect one.");
    }

    const first = await attempt(current.accessToken);
    if (first.status !== 401) return first;

    const refreshed = await refreshXaiSubscription(configDir, fetchFn);
    if (refreshed.status !== "ok") return first;
    return attempt(refreshed.subscription.accessToken);
  }) as typeof fetch;
}

export function subscriptionCredentialFromXai(
  subscription: XaiSubscription,
): SubscriptionCredential | undefined {
  if (subscription.accountId === undefined || subscription.accountId.length === 0) return undefined;
  const expiresAt =
    subscription.expiresAt !== undefined ? Date.parse(subscription.expiresAt) : Number.NaN;
  return {
    provider: "xai",
    accessToken: subscription.accessToken,
    accountId: subscription.accountId,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

export const refreshGrokSubscription: RefreshSubscription = async (configDir) => {
  const result = await refreshXaiSubscription(configDir);
  if (result.status !== "ok") return undefined;
  return subscriptionCredentialFromXai(result.subscription);
};

export const refreshXaiCredential: RefreshSubscription = async (configDir) => {
  const result = await refreshXaiSubscription(configDir);
  if (result.status !== "ok") {
    const message =
      result.status === "error" ||
      result.status === "tier-denied" ||
      result.status === "reconnect-required"
        ? result.message
        : result.status;
    throw new Error(message);
  }
  const credential = subscriptionCredentialFromXai(result.subscription);
  if (credential === undefined) {
    throw new Error("Grok subscription is missing accountId");
  }
  return credential;
};
