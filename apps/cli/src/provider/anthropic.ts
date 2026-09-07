import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

export function getAnthropicModel(
  modelId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.anthropic),
): LanguageModel {
  if (!apiKey) throw missingKeyError("anthropic");
  return createAnthropic({ apiKey })(modelId);
}
