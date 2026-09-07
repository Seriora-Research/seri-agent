import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";
import { loadOpenRouterPin } from "./sampling";

// compatibility: "strict" talks to OpenRouter directly; "compatible" is for a third-party OpenAI-compatible endpoint.
// session_id via extraBody is OpenRouter sticky routing (https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/); a pin and session_id conflict.
export function getOpenRouterModel(
  modelId: string,
  sessionId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.openrouter),
  configDir?: string,
): LanguageModel {
  if (!apiKey) throw missingKeyError("openrouter");

  const pin = loadOpenRouterPin(configDir);
  const extraBody =
    pin === undefined
      ? { session_id: sessionId }
      : { provider: { order: pin, allow_fallbacks: false } };
  return createOpenRouter({ apiKey, compatibility: "strict" })(modelId, {
    extraBody,
  });
}
