import { onAbort } from "../abort";
import { type AuthSession, loadAuthSession } from "../auth/authStore";
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

    // refreshSession's own in-flight map (auth/refresh.ts) dedupes concurrent 401s against the
    // same configDir into ONE shared refresh — its own comment names the real caller this exists
    // for: dispatch_subagents running several reader subagents against the same gateway model.
    // Binding THIS caller's signal into that shared operation (a prior version of this function
    // did) would let whichever caller happens to arrive first hand ITS OWN cancellation the power
    // to abort every other concurrent caller's wait too, even though their own deadlines never
    // expired. So the signal only races THIS caller's own wait for the result — never the shared
    // operation itself, which has its own independent bounded lifetime
    // (refresh.ts's own REFRESH_TIMEOUT_MS) regardless of whether any caller ever supplies one.
    const signal = init?.signal ?? undefined;
    const refreshed = await new Promise<AuthSession | undefined>((resolve, reject) => {
      const pending = refreshSession(configDir, fetchFn);
      const abort = onAbort(signal, () => reject(signal?.reason));
      pending.then(
        (value) => {
          abort.dispose();
          resolve(value);
        },
        (error) => {
          abort.dispose();
          reject(error);
        },
      );
    });
    if (!refreshed) return response;

    headers.set("Authorization", `Bearer ${refreshed.accessToken}`);
    return fetchFn(input, { ...requestInit, headers });
  };
}
