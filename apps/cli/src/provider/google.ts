import { createGoogle } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

// createGoogleGenerativeAI is a re-export alias of createGoogle.
export function getGoogleModel(
  modelId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.google),
): LanguageModel {
  if (!apiKey) throw missingKeyError("google");
  return createGoogle({ apiKey })(modelId);
}
