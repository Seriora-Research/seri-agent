import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

// No default for modelId, matching groq.ts: the caller (provider/model.ts) is the single
// authority on what id to construct with.
//
// The bare callable, not `.chat(modelId)`: confirmed against the installed
// @ai-sdk/openai@4.0.36's own dist/index.d.ts — OpenAIProvider's bare call signature takes an
// `OpenAIResponsesModelId` and is the Responses API model, while `.chat()` takes a separate
// `OpenAIChatModelId` and is Chat Completions. This picks the Responses API (the provider's own
// default surface); `.chat()` is the documented fallback if seri's loop ever needs Chat
// Completions' different tool-call/streaming shape instead.
//
// `apiKey` defaults to today's lookup but can be overridden — see anthropic.ts's own comment on
// why (validate.ts's probe call, D5).
export function getOpenAIModel(
  modelId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.openai),
): LanguageModel {
  if (!apiKey) throw missingKeyError("openai");
  return createOpenAI({ apiKey })(modelId);
}
