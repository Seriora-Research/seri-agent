import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";

// gpt-oss-120b over llama-3.3-70b-versatile: 20/20 real tool calls against 5/11, measured
// 2026-08-07 AFTER the prompt in agents/systemPrompt.ts was written, so this is a model problem and
// not a prompt problem. Method, the sample-size caveat on llama's 11, and the earlier pre-prompt
// numbers are in docs/PROMPT-ROUTING.md, which is where that dataset lives.
export const DEFAULT_MODEL = "openai/gpt-oss-120b";

// No default for modelId: provider/defaults.ts's resolveDefaultModel() is the single authority on
// what to use when nothing was asked for, and a default here would encode that answer a second
// place to drift from.
export function getGroqModel(modelId: string): LanguageModel {
  const apiKey = getApiKey("GROQ_API_KEY");
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set. Run: seri config set GROQ_API_KEY <your-key>");
  }
  return createGroq({ apiKey })(modelId);
}
