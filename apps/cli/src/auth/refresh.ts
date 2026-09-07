import { fetchWithTimeout } from "@seri/model-catalog";
import { type AuthSession, expiresAtFrom, loadAuthSession, saveAuthSession } from "./authStore";
import { AUTHENTICATE_URL, getWorkosClientId, parseResponseBody } from "./deviceFlow";

export type RefreshResult =
  | { status: "success"; accessToken: string; refreshToken: string; expiresIn?: number }
  | { status: "error"; message: string };







const REFRESH_TIMEOUT_MS = 10_000;







export async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<RefreshResult> {
  try {
    return await fetchWithTimeout(
      fetchFn,
      AUTHENTICATE_URL,
      REFRESH_TIMEOUT_MS,
      async (response): Promise<RefreshResult> => {




        let body: Record<string, unknown>;
        try {
          body = await parseResponseBody(response);
        } catch (error) {
          return {
            status: "error",
            message: `WorkOS refresh response unreadable: ${String(error)}`,
          };
        }
        if (!response.ok) {
          return {
            status: "error",
            message: `WorkOS refresh failed with status ${response.status}: ${JSON.stringify(body)}`,
          };
        }




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
      },
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        }).toString(),
      },
    );
  } catch (error) {
    return { status: "error", message: `WorkOS refresh request failed: ${String(error)}` };
  }
}







const inFlightRefreshes = new Map<string, Promise<AuthSession | undefined>>();

export function refreshSession(
  configDir: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthSession | undefined> {
  const existing = inFlightRefreshes.get(configDir);
  if (existing) return existing;

  const promise = refreshSessionOnce(configDir, fetchFn);
  inFlightRefreshes.set(configDir, promise);





  promise.finally(() => inFlightRefreshes.delete(configDir)).catch(() => {});
  return promise;
}



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




  const updated: AuthSession = {
    ...session,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: expiresAtFrom(result.expiresIn),
  };
  saveAuthSession(updated, configDir);
  return updated;
}
