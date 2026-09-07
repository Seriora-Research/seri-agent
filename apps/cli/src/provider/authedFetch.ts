import { onAbort } from "../abort";
import { type AuthSession, loadAuthSession } from "../auth/authStore";
import { refreshSession as refreshSessionReal } from "../auth/refresh";

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
