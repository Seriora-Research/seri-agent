import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { loadXaiSubscription } from "../auth/xaiAuthStore";
import { xaiAuthedFetch } from "../auth/xaiRefresh";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

export const XAI_BASE_URL_DEFAULT = "https://api.x.ai/v1";

export function xaiBaseUrl(configDir?: string): string {
  return getApiKey("SERI_XAI_BASE_URL", configDir) ?? XAI_BASE_URL_DEFAULT;
}

export const GROK_PROXY_BASE_URL_DEFAULT = "https://cli-chat-proxy.grok.com/v1";
export const GROK_PROXY_VERSION = "1.0.6";
export const GROK_CLIENT_IDENTIFIER = "seri";

export function grokProxyBaseUrl(configDir?: string): string {
  return getApiKey("SERI_GROK_PROXY_BASE_URL", configDir) ?? GROK_PROXY_BASE_URL_DEFAULT;
}

// The Grok CLI proxy gates on these headers.
export function grokSubscriptionHeaders(opts: {
  modelId: string;
  sessionId?: string;
  accountId?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-version": GROK_PROXY_VERSION,
    "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
    "x-grok-model-override": opts.modelId,
  };
  if (opts.accountId !== undefined && opts.accountId.length > 0) {
    headers["x-grok-user-id"] = opts.accountId;
  }
  if (opts.sessionId !== undefined && opts.sessionId.length > 0) {
    headers["x-grok-conv-id"] = opts.sessionId;
  }
  return headers;
}

export function grokCatalogHeaders(accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_PROXY_VERSION,
  };
  if (accountId !== undefined && accountId.length > 0) {
    headers["x-userid"] = accountId;
  }
  return headers;
}

// api.x.ai/v1 is Chat Completions (.chat()); the Grok CLI proxy is Responses (bare callable).
export function getXaiModel(
  modelId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.xai),
  configDir?: string,
): LanguageModel {
  if (!apiKey) throw missingKeyError("xai");
  return createOpenAI({ apiKey, baseURL: xaiBaseUrl(configDir) }).chat(modelId);
}

// createOpenAI requires a non-empty apiKey; xaiAuthedFetch sets Authorization per request.
const UNUSED_PLACEHOLDER_KEY = "unused-subscription-placeholder";

export function getXaiSubscriptionModel(
  modelId: string,
  configDir: string,
  sessionId?: string,
  fetchFn: typeof fetch = fetch,
): LanguageModel {
  const authed = xaiAuthedFetch(configDir, fetchFn);
  return createOpenAI({
    apiKey: UNUSED_PLACEHOLDER_KEY,
    baseURL: grokProxyBaseUrl(configDir),
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const current = loadXaiSubscription(configDir);
      const grok = grokSubscriptionHeaders({
        modelId,
        sessionId,
        accountId: current?.accountId,
      });
      return authed(input, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          ...grok,
        },
      });
    }) as typeof fetch,
  })(modelId);
}
