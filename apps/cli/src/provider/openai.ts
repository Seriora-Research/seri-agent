import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

// The bare callable is the Responses API; .chat() is Chat Completions.
export function getOpenAIModel(
  modelId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.openai),
): LanguageModel {
  if (!apiKey) throw missingKeyError("openai");
  return createOpenAI({ apiKey })(modelId);
}
