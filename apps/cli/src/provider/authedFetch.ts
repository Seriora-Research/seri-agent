import { loadAuthSession } from "../auth/authStore";
import { refreshSession as refreshSessionReal } from "../auth/refresh";

// The Authorization header is read fresh here, from disk, on every call — not baked into a
// caller's client config at construction time — so a token refreshed by THIS wrapper's own
// retry (below) is picked up by every later request the same client makes, not just the one
// that triggered the refresh. Shared by gateway.ts and accountStatus.ts, the two CLI-side
// callers of our own server that both need the identical retry-once-on-401 behavior.
export function authedFetch(
  configDir: string,
  fetchFn: typeof fetch,
  refreshSession: typeof refreshSessionReal,
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const session = loadAuthSession(configDir);
    if (session) headers.set("Authorization", `Bearer ${session.accessToken}`);
    const requestInit = { ...init, headers };

    const response = await fetchFn(input, requestInit);
    if (response.status !== 401) return response;

    const refreshed = await refreshSession(configDir, fetchFn);
    if (!refreshed) return response;

    headers.set("Authorization", `Bearer ${refreshed.accessToken}`);
    return fetchFn(input, { ...requestInit, headers });
  };
}
