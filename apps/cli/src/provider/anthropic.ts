import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

// No default for modelId, matching groq.ts: the caller (provider/model.ts) is the single
// authority on what id to construct with.
//
// `apiKey` defaults to today's lookup but can be overridden — validate.ts's own probe call
// (D5, feature-plan.md) needs to build a client from a CANDIDATE key that has not been saved to
// config.json yet, and this is the seam that lets it reuse this constructor instead of a second,
// parallel provider-integration surface.
export function getAnthropicModel(
  modelId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.anthropic),
): LanguageModel {
  if (!apiKey) throw missingKeyError("anthropic");
  return createAnthropic({ apiKey })(modelId);
}
