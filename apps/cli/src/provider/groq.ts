import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

export const DEFAULT_MODEL = "openai/gpt-oss-120b";

export function getGroqModel(
  modelId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.groq),
): LanguageModel {
  if (!apiKey) throw missingKeyError("groq");
  return createGroq({ apiKey })(modelId);
}
