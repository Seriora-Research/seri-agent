import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";

// Measured, 2026-08-07, on the prompt in agents/systemPrompt.ts: same binary, same task
// ("Use the read_file tool to read <file> and tell me the exact text it contains"), fresh session
// per run, in a scratch directory with no AGENTS.md in any ancestor.
//
//   openai/gpt-oss-120b       20/20 real read_file calls   (5/5 on the old 29-char prompt)
//   llama-3.3-70b-versatile    5/10 real read_file calls   (3/5 on the old 29-char prompt)
//
// The other 10 llama runs never reached the model — Groq's tokens-per-day cap for that model was
// exhausted mid-measurement — so they are excluded rather than scored as failures. Every one of the
// 5 llama failures was Groq's `Failed to call a function. Please adjust your prompt.`
//
// The order of that experiment is the point: the prompt was written and measured FIRST, so this
// constant is changed on evidence that the prompt is not what was wrong. Tool guidance did not move
// llama (60% → 50%, inside the noise of ten runs); it is simply a weak tool-caller, and tool calling
// is this product's core operation. gpt-oss-120b is free on the same provider.
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
export function resolveModelId(configDir?: string): string {
  return getApiKey("SERI_MODEL", configDir) ?? DEFAULT_MODEL;
}

export function getGroqModel(modelId: string = DEFAULT_MODEL): LanguageModel {
  const apiKey = getApiKey("GROQ_API_KEY");
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set. Run: seri config set GROQ_API_KEY <your-key>");
  }
  return createGroq({ apiKey })(modelId);
}
