import { createOpenAI } from "@ai-sdk/openai";
import type { ModelProvider } from "@seri/model-catalog";
import type { LanguageModel } from "ai";
import { loadAuthSession } from "../auth/authStore";
import { refreshSession as refreshSessionReal } from "../auth/refresh";
import { getApiKey } from "../config/config";
import { authedFetch } from "./authedFetch";
import { configuredProviders } from "./keys";

const DEFAULT_GATEWAY_URL = "https://api.seriora.ai/api/gateway";

const STALE_GATEWAY_HOSTS: Readonly<Record<string, string>> = {
  "gateway-dev.seriora.ai": "api-dev.seriora.ai",
  "gateway.seriora.ai": "api.seriora.ai",
};

function rewriteStaleGatewayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const nextHost = STALE_GATEWAY_HOSTS[parsed.hostname];
    if (nextHost === undefined) return url;
    parsed.hostname = nextHost;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function gatewayBaseUrl(configDir: string): string {
  return rewriteStaleGatewayUrl(getApiKey("SERI_GATEWAY_URL", configDir) ?? DEFAULT_GATEWAY_URL);
}

// createOpenAI requires a non-empty apiKey; authedFetch overwrites Authorization per request.
const UNUSED_PLACEHOLDER_KEY = "seri-gateway";

type GatewayDeps = {
  fetchFn?: typeof fetch;
  refreshSession?: typeof refreshSessionReal;
};

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

  if (!loadAuthSession(configDir))
    throw new Error("Not logged in. Run /login inside the TUI, or configure a provider API key.");

  const fetchFn = deps.fetchFn ?? fetch;
  const refreshSession = deps.refreshSession ?? refreshSessionReal;

  return createOpenAI({
    baseURL: gatewayBaseUrl(configDir),
    apiKey: UNUSED_PLACEHOLDER_KEY,
    headers: {
      "X-Seri-Session-Id": sessionId,
    },

    // bun-types adds fetch.preconnect; @ai-sdk/openai's FetchFunction inherits it.
    fetch: authedFetch(configDir, fetchFn, refreshSession) as typeof fetch,
  }).chat(modelId);
}
