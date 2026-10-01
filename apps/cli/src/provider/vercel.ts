import { createGateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

export function getVercelModel(
  modelId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.vercel),
): LanguageModel {
  if (!apiKey) throw missingKeyError("vercel");
  return createGateway({ apiKey })(modelId);
}
