import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { xaiAuthedFetch } from "../auth/xaiRefresh";
import { loadXaiSubscription } from "../auth/xaiAuthStore";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

// xAI's OpenAI-compatible Chat Completions surface. The key path keeps this host; the
// subscription path does not (GROK_PROXY_BASE_URL). Overridable so a test or an enterprise
// deployment can point the key client without a rebuild.
export const XAI_BASE_URL_DEFAULT = "https://api.x.ai/v1";

export function xaiBaseUrl(configDir?: string): string {
  return getApiKey("SERI_XAI_BASE_URL", configDir) ?? XAI_BASE_URL_DEFAULT;
}

// The Grok CLI chat proxy. Serves Responses, not Chat Completions, and gates on the header set
// grokSubscriptionHeaders builds. Overridable the same way the key host is.
export const GROK_PROXY_BASE_URL_DEFAULT = "https://cli-chat-proxy.grok.com/v1";
export const GROK_PROXY_VERSION = "1.0.6";
export const GROK_CLIENT_IDENTIFIER = "seri";

export function grokProxyBaseUrl(configDir?: string): string {
  return getApiKey("SERI_GROK_PROXY_BASE_URL", configDir) ?? GROK_PROXY_BASE_URL_DEFAULT;
}

// Protocol constants the proxy gates on, plus the one identity claim that is ours.
// `x-grok-client-identifier` is asserted as the literal "seri" in tests so a later edit cannot
// quietly claim to be Grok Build or fx.
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

// `.chat(modelId)`, NOT the bare callable openai.ts uses. The bare call signature on
// @ai-sdk/openai@4.0.36 selects the Responses API; `api.x.ai/v1` serves ordinary Chat
// Completions, which is the same reason gateway.ts calls `.chat()` too. Copying openai.ts
// verbatim here would build a client for a surface this host does not expose.
//
// `apiKey` is overridable for validate.ts's probe, matching every other get<X>Model.
export function getXaiModel(
  modelId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.xai),
  configDir?: string,
): LanguageModel {
  if (!apiKey) throw missingKeyError("xai");
  return createOpenAI({ apiKey, baseURL: xaiBaseUrl(configDir) }).chat(modelId);
}

// createOpenAI still demands an apiKey even though every request's Authorization header is set
// per-request inside xaiAuthedFetch from the freshly-read stored token. Same placeholder shape
// gateway.ts uses, and for the same reason.
const UNUSED_PLACEHOLDER_KEY = "unused-subscription-placeholder";

// The subscription-backed client: the Grok CLI proxy, the Responses surface (the bare callable),
// and the header set the proxy gates on. Distinct from getXaiModel on both host and API shape.
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
