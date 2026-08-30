import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { xaiAuthedFetch } from "../auth/xaiRefresh";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

// xAI's OpenAI-compatible surface. Overridable through the same env-then-config lookup every
// other provider constant uses, so pointing at the cli-chat-proxy host instead never needs a
// rebuild (docs/specs/040-grok-subscription/research.md covers why api.x.ai is the default).
export const XAI_BASE_URL_DEFAULT = "https://api.x.ai/v1";

export function xaiBaseUrl(configDir?: string): string {
  return getApiKey("SERI_XAI_BASE_URL", configDir) ?? XAI_BASE_URL_DEFAULT;
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

// The subscription-backed client: same base URL and same chat surface as the key path, but the
// credential is a rotating OAuth bearer rather than a static key, so the fetch wrapper owns
// attaching it and refreshing it on a 401.
export function getXaiSubscriptionModel(
  modelId: string,
  configDir: string,
  fetchFn: typeof fetch = fetch,
): LanguageModel {
  return createOpenAI({
    apiKey: UNUSED_PLACEHOLDER_KEY,
    baseURL: xaiBaseUrl(configDir),
    // Cast for the same bun-types reason gateway.ts documents: bun augments the global fetch with
    // a static preconnect member that the AI SDK's own FetchFunction type then inherits here.
    fetch: xaiAuthedFetch(configDir, fetchFn) as typeof fetch,
  }).chat(modelId);
}
