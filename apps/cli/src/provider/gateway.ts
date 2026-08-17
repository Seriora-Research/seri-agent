import { createOpenAI } from "@ai-sdk/openai";
import type { ModelProvider } from "@seri/model-catalog";
import type { LanguageModel } from "ai";
import { loadAuthSession } from "../auth/authStore";
import { refreshSession as refreshSessionReal } from "../auth/refresh";
import { getApiKey } from "../config/config";
import { configuredProviders } from "./keys";

// Unlike every sibling in this directory, this file's credential is the session access token
// from auth/authStore.ts, not a provider API key from keys.ts — the whole point of the file is
// that it talks to OUR OWN server, which forwards to the real provider on seri's own key.

// Provisional: apps/server has no confirmed production domain yet. SERI_GATEWAY_URL overrides
// this, so pointing the CLI at a local apps/server needs no rebuild.
const DEFAULT_GATEWAY_URL = "https://gateway.seriora.ai/api/gateway";

function gatewayBaseUrl(configDir: string): string {
  return getApiKey("SERI_GATEWAY_URL", configDir) ?? DEFAULT_GATEWAY_URL;
}

// The retry-once-on-401 wrapper (D4): replays the SAME request — including its
// X-Seri-Idempotency-Key header, already set by createOpenAI's own `headers` option below — with
// a refreshed Authorization header. One retry, never a loop: only the FIRST fetchFn call's
// status is ever inspected; whatever the retried call returns is returned as-is.
function authedFetch(
  configDir: string,
  fetchFn: typeof fetch,
  refreshSession: typeof refreshSessionReal,
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetchFn(input, init);
    if (response.status !== 401) return response;

    const refreshed = await refreshSession(configDir, fetchFn);
    if (!refreshed) return response;

    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${refreshed.accessToken}`);
    return fetchFn(input, { ...init, headers });
  };
}

type GatewayDeps = {
  fetchFn?: typeof fetch;
  refreshSession?: typeof refreshSessionReal;
};

// D2's BYOK guard, D4's sticky-routing/idempotency headers. `sessionId` is the CLI session id
// (sticky routing / prompt-cache behaviour, injected server-side as `session_id`); the
// idempotency key is a UUID minted once per logical request here and reused unchanged by
// authedFetch's own retry.
export function getGatewayModel(
  modelId: string,
  provider: ModelProvider,
  sessionId: string,
  configDir: string,
  deps: GatewayDeps = {},
): LanguageModel {
  if (configuredProviders(configDir).has(provider)) {
    throw new Error(
      `${provider} has a locally-configured key; a BYOK provider must never be routed through the gateway.`,
    );
  }

  const session = loadAuthSession(configDir);
  if (!session) throw new Error("Not logged in. Run: seri login");

  const fetchFn = deps.fetchFn ?? fetch;
  const refreshSession = deps.refreshSession ?? refreshSessionReal;

  return createOpenAI({
    baseURL: gatewayBaseUrl(configDir),
    apiKey: session.accessToken,
    headers: {
      "X-Seri-Session-Id": sessionId,
      "X-Seri-Idempotency-Key": crypto.randomUUID(),
    },
    // Cast needed only because bun-types augments the global `fetch` type with a static
    // `preconnect` member that @ai-sdk/openai's own FetchFunction type then inherits in this
    // project's compilation — AI SDK never calls `.preconnect` on an injected fetch override.
    fetch: authedFetch(configDir, fetchFn, refreshSession) as typeof fetch,
  }).chat(modelId);
}
