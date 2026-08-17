import { type AuthSession, loadAuthSession, saveAuthSession } from "./authStore";
import { AUTHENTICATE_URL, getWorkosClientId } from "./deviceFlow";

export type RefreshResult =
  | { status: "success"; accessToken: string; refreshToken: string; expiresIn: number }
  | { status: "error"; message: string };

// Matches deviceFlow.ts's own parseResponseBody: a non-JSON error body must not throw an
// unhandled SyntaxError.
async function parseResponseBody(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

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
  const body = await parseResponseBody(response);
  if (!response.ok) {
    return {
      status: "error",
      message: `WorkOS refresh failed with status ${response.status}: ${JSON.stringify(body)}`,
    };
  }
  // A 200 with an unexpected body shape must not persist undefined tokens into auth.json — the
  // same trust boundary as pollForToken's own response.ok check, applied to the fields inside it.
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
    expiresIn: body.expires_in,
  };
}

// WorkOS rotates refresh tokens on every use, so the response's refresh_token — not the one
// this call started with — is what has to be persisted, or the next refresh fails.
export async function refreshSession(
  configDir: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthSession | undefined> {
  const session = loadAuthSession(configDir);
  if (!session) return undefined;

  const result = await refreshAccessToken(
    getWorkosClientId(configDir),
    session.refreshToken,
    fetchFn,
  );
  if (result.status === "error") return undefined;

  const updated: AuthSession = {
    ...session,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: new Date(Date.now() + result.expiresIn * 1000).toISOString(),
  };
  saveAuthSession(updated, configDir);
  return updated;
}
