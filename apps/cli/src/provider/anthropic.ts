import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";

// No default for modelId, matching groq.ts: the caller (provider/model.ts) is the single
// authority on what id to construct with.
export function getAnthropicModel(modelId: string): LanguageModel {
  const apiKey = getApiKey("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Run: seri config set ANTHROPIC_API_KEY <your-key>",
    );
  }
  return createAnthropic({ apiKey })(modelId);
}
