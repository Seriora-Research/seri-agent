import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
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
