import { type AuthSession, expiresAtFrom, loadAuthSession, saveAuthSession } from "./authStore";
import { AUTHENTICATE_URL, getWorkosClientId, parseResponseBody } from "./deviceFlow";

export type RefreshResult =
  | { status: "success"; accessToken: string; refreshToken: string; expiresIn?: number }
  | { status: "error"; message: string };

// A raw fetch POST, matching deviceFlow.ts's pollForToken/requestDeviceCode style rather than
// introducing @workos-inc/node client-side. Never throws — a caller (refreshSession below, or
// gateway.ts's authedFetch) treats a failed refresh as "could not refresh", not as an
// exception to propagate. That includes fetchFn itself rejecting (offline, DNS failure): caught
// here so authedFetch's fallback to the original 401 response is reached instead of an uncaught
// rejection replacing it.
export async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<RefreshResult> {
  let response: Response;
  try {
    response = await fetchFn(AUTHENTICATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });
  } catch (error) {
    return { status: "error", message: `WorkOS refresh request failed: ${String(error)}` };
  }
  // response.text() (inside parseResponseBody) can reject if the connection drops mid-read —
  // caught here too, or that rejection would escape refreshAccessToken's no-throw contract and
  // stop authedFetch from falling back to the original 401 response.
  let body: Record<string, unknown>;
  try {
    body = await parseResponseBody(response);
  } catch (error) {
    return { status: "error", message: `WorkOS refresh response unreadable: ${String(error)}` };
  }
  if (!response.ok) {
    return {
      status: "error",
      message: `WorkOS refresh failed with status ${response.status}: ${JSON.stringify(body)}`,
    };
  }
  // A 200 with an unexpected body shape must not persist undefined tokens into auth.json — the
  // same trust boundary as pollForToken's own response.ok check, applied to the fields inside
  // it. expires_in is deliberately NOT required here: WorkOS's real response carries no such
  // field (confirmed live), so its absence is the normal shape, not a malformed one.
  if (
    typeof body.access_token !== "string" ||
    !body.access_token ||
    typeof body.refresh_token !== "string" ||
    !body.refresh_token
  ) {
    return { status: "error", message: "WorkOS refresh response is missing token fields" };
  }
  return {
    status: "success",
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : undefined,
  };
}

// Concurrent 401s against the same configDir (e.g. dispatch_subagents running several reader
// subagents against the same gateway model) can each read the same on-disk refresh token before
// either submits it. WorkOS accepts only one use of a rotating refresh token, so the loser would
// get {status: "error"} and strand its caller on the original 401 even though a valid rotated
// pair now exists on disk. One in-flight promise per configDir makes every concurrent caller
// share the same refresh instead of racing separate ones.
const inFlightRefreshes = new Map<string, Promise<AuthSession | undefined>>();

export function refreshSession(
  configDir: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthSession | undefined> {
  const existing = inFlightRefreshes.get(configDir);
  if (existing) return existing;

  const promise = refreshSessionOnce(configDir, fetchFn);
  inFlightRefreshes.set(configDir, promise);
  promise.finally(() => inFlightRefreshes.delete(configDir));
  return promise;
}

// WorkOS rotates refresh tokens on every use, so the response's refresh_token — not the one
// this call started with — is what has to be persisted, or the next refresh fails.
async function refreshSessionOnce(
  configDir: string,
  fetchFn: typeof fetch,
): Promise<AuthSession | undefined> {
  const session = loadAuthSession(configDir);
  if (!session) return undefined;

  const result = await refreshAccessToken(
    getWorkosClientId(configDir),
    session.refreshToken,
    fetchFn,
  );
  if (result.status === "error") return undefined;

  // A stale expiresAt carried over from the previous session would describe the OLD token, not
  // this one — worse than no hint at all — so a missing expiresIn clears it rather than keeping
  // the old value.
  const updated: AuthSession = {
    ...session,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: expiresAtFrom(result.expiresIn),
  };
  saveAuthSession(updated, configDir);
  return updated;
}
