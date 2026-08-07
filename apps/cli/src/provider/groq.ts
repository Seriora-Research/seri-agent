import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";

// gpt-oss-120b over llama-3.3-70b-versatile: 20/20 real tool calls against 5/11, measured
// 2026-08-07 AFTER the prompt in agents/systemPrompt.ts was written, so this is a model problem and
// not a prompt problem. Method, the sample-size caveat on llama's 11, and the earlier pre-prompt
// numbers are in docs/PROMPT-ROUTING.md, which is where that dataset lives.
export const DEFAULT_MODEL = "openai/gpt-oss-120b";

// `SERI_MODEL`, with the env-then-config precedence loadVerifyConfig already established
// (config/config.ts:56-79). getApiKey despite the name: it is exactly `env || config || undefined`,
// including the deliberate `||` that lets an empty env var fall through, and duplicating that here
// would mean duplicating the reasoning behind it too.
//
// The escape hatch matters because the default is a judgement about which model calls tools
// reliably today, and a user who disagrees — or whose account cannot reach it — should not have to
// recompile. Before this, changing model meant editing a constant and rebuilding, which measurably
// slowed the diagnosis that produced this file's default.
export function resolveModelId(): string {
  return getApiKey("SERI_MODEL") ?? DEFAULT_MODEL;
}

// No default for modelId: resolveModelId is the single authority on what to use when nothing was
// asked for, and a default here would encode that answer a second place to drift from at Stage 7a.
export function getGroqModel(modelId: string): LanguageModel {
  const apiKey = getApiKey("GROQ_API_KEY");
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set. Run: seri config set GROQ_API_KEY <your-key>");
  }
  return createGroq({ apiKey })(modelId);
}
