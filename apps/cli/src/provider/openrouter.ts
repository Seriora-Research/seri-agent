import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";

// No default for modelId, matching groq.ts: the caller (provider/model.ts) is the single
// authority on what id to construct with.
//
// `compatibility: "strict"`, not the package default ("compatible"): the installed
// @openrouter/ai-sdk-provider@3.0.0's own settings doc says to use "strict" specifically when
// talking to the OpenRouter API directly (as this file does) and "compatible" only when routing a
// THIRD-PARTY provider's own OpenAI-compatible endpoint through it — seri is squarely the first
// case. `usage: { include: true }`, the older explicit opt-in for usage accounting, is deliberately
// NOT set here: PROMPT-ROUTING.md's own 7a research already found "OpenRouter returns usage.cost...
// on every response, always, with no opt-in (the old usage: { include: true } parameter is
// deprecated and inert)" — confirmed again directly against the live API (2026-08-09, gpt-oss-20b):
// `providerMetadata.openrouter.usage.cost` came back populated with `compatibility: "strict"` alone,
// and identically with `usage.include` also set, so adding it back would be speculative
// configurability with a measured null effect, not a fix for anything. A prior round of this
// feature (MEDIUM-1) assumed cost needed an explicit opt-in seri wasn't making; both the design doc
// and a live check say that assumption was wrong for this SDK version, so it is not carried forward.
export function getOpenRouterModel(modelId: string): LanguageModel {
  const apiKey = getApiKey("OPENROUTER_API_KEY");
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Run: seri config set OPENROUTER_API_KEY <your-key>",
    );
  }
  return createOpenRouter({ apiKey, compatibility: "strict" })(modelId);
}
