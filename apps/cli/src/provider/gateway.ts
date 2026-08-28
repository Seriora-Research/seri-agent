import { createOpenAI } from "@ai-sdk/openai";
import type { ModelProvider } from "@seri/model-catalog";
import type { LanguageModel } from "ai";
import { loadAuthSession } from "../auth/authStore";
import { refreshSession as refreshSessionReal } from "../auth/refresh";
import { getApiKey } from "../config/config";
import { authedFetch } from "./authedFetch";
import { configuredProviders } from "./keys";

// Unlike every sibling in this directory, this file's credential is the session access token
// from auth/authStore.ts, not a provider API key from keys.ts — the whole point of the file is
// that it talks to OUR OWN server, which forwards to the real provider on seri's own key.

// Provisional: apps/server has no confirmed production domain yet. SERI_GATEWAY_URL overrides
// this, so pointing the CLI at a local apps/server needs no rebuild.
const DEFAULT_GATEWAY_URL = "https://gateway.seriora.ai/api/gateway";

// Exported so accountStatus.ts can reach the same server without a second SERI_GATEWAY_URL
// resolution — both files talk to the same apps/server deployment.
export function gatewayBaseUrl(configDir: string): string {
  return getApiKey("SERI_GATEWAY_URL", configDir) ?? DEFAULT_GATEWAY_URL;
}

// Never used for real auth — authedFetch below overwrites the Authorization header on every
// call, reading the current on-disk session fresh each time. createOpenAI still requires a
// non-empty apiKey to construct, so this is only a placeholder to satisfy that.
const UNUSED_PLACEHOLDER_KEY = "seri-gateway";

type GatewayDeps = {
  fetchFn?: typeof fetch;
  refreshSession?: typeof refreshSessionReal;
};

// The BYOK guard, plus the sticky-routing header a gateway request needs. `sessionId` is the
// CLI session id (sticky routing / prompt-cache behaviour, injected server-side as
// `session_id`); the Authorization header is set per-request inside authedFetch, not here —
// see its comment.
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

  // Checked here only to fail fast with a clear message before constructing anything — the
  // credential actually used per-request is re-read fresh inside authedFetch.
  if (!loadAuthSession(configDir)) throw new Error("Not logged in. Run /login");

  const fetchFn = deps.fetchFn ?? fetch;
  const refreshSession = deps.refreshSession ?? refreshSessionReal;

  return createOpenAI({
    baseURL: gatewayBaseUrl(configDir),
    apiKey: UNUSED_PLACEHOLDER_KEY,
    headers: {
      "X-Seri-Session-Id": sessionId,
    },
    // Cast needed only because bun-types augments the global `fetch` type with a static
    // `preconnect` member that @ai-sdk/openai's own FetchFunction type then inherits in this
    // project's compilation — AI SDK never calls `.preconnect` on an injected fetch override.
    fetch: authedFetch(configDir, fetchFn, refreshSession) as typeof fetch,
  }).chat(modelId);
}
