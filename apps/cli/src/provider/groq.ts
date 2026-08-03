import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";

export const DEFAULT_MODEL = "llama-3.3-70b-versatile";

export function getGroqModel(modelId: string = DEFAULT_MODEL): LanguageModel {
  const apiKey = getApiKey("GROQ_API_KEY");
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set. Run: hesper config set GROQ_API_KEY <your-key>");
  }
  return createGroq({ apiKey })(modelId);
}
