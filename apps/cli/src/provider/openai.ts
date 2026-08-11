import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";

// No default for modelId, matching groq.ts: the caller (provider/model.ts) is the single
// authority on what id to construct with.
//
// The bare callable, not `.chat(modelId)`: confirmed against the installed
// @ai-sdk/openai@4.0.36's own dist/index.d.ts — OpenAIProvider's bare call signature takes an
// `OpenAIResponsesModelId` and is the Responses API model, while `.chat()` takes a separate
// `OpenAIChatModelId` and is Chat Completions. This picks the Responses API (the provider's own
// default surface); `.chat()` is the documented fallback if seri's loop ever needs Chat
// Completions' different tool-call/streaming shape instead.
export function getOpenAIModel(modelId: string): LanguageModel {
  const apiKey = getApiKey("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Run: seri config set OPENAI_API_KEY <your-key>");
  }
  return createOpenAI({ apiKey })(modelId);
}
