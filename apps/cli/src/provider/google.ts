import { createGoogle } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";

// No default for modelId, matching groq.ts: the caller (provider/model.ts) is the single
// authority on what id to construct with.
//
// `GOOGLE_GENERATIVE_AI_API_KEY`, not a shorter `GOOGLE_API_KEY`: matches the installed
// @ai-sdk/google@4.0.39's own implicit env-var default, so a user who already exports it for
// some other tool works here too — read explicitly via getApiKey regardless, same as every other
// provider in this directory, never relying on the SDK's own fallback.
//
// `createGoogle`, not `createGoogleGenerativeAI`: confirmed against the installed package's own
// dist/index.d.ts — `createGoogleGenerativeAI` is exported only as `createGoogle as
// createGoogleGenerativeAI`, i.e. a re-export alias of the same function under its old name.
// `createGoogle` is the canonical one at this version.
export function getGoogleModel(modelId: string): LanguageModel {
  const apiKey = getApiKey("GOOGLE_GENERATIVE_AI_API_KEY");
  if (!apiKey) {
    throw new Error(
      "GOOGLE_GENERATIVE_AI_API_KEY is not set. Run: seri config set GOOGLE_GENERATIVE_AI_API_KEY <your-key>",
    );
  }
  return createGoogle({ apiKey })(modelId);
}
