import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";

// No default for modelId, matching groq.ts: the caller (provider/model.ts) is the single
// authority on what id to construct with.
//
// Two settings, both required for `providerMetadata.openrouter.usage.cost` (cost.ts's own
// reportForOpenRouter) to actually show up, confirmed against the installed
// @openrouter/ai-sdk-provider@3.0.0's compiled source (dist/index.js), not just its .d.ts:
// `compatibility: "strict"` is what makes the provider send `stream_options.include_usage: true`
// on the request at all — in the default "compatible" mode it sends no stream_options, which is
// the OpenAI-protocol switch that makes a STREAMING response emit a final usage-bearing chunk in
// the first place (dist/index.js:3888-3890, `stream_options: this.config.compatibility ===
// "strict" ? {include_usage: true, …} : void 0` — unconditional once strict, no per-call opt-in
// needed on top). `usage: { include: true }`, passed as a per-model setting rather than a
// per-call one (this repo's loop.ts calls streamText with no OpenRouter-specific settings of its
// own), is OpenRouter's own top-level extension that asks for the DOLLAR figure specifically —
// sent as a plain `usage` field on every request body regardless of compatibility mode
// (dist/index.js:3638, `usage: this.settings.usage`), but the `cost` field on the response's
// `usage` object (OpenRouterUsageAccounting.cost) is only populated when this is set. Without the
// first, streaming requests get no final usage chunk to read `cost` off at all; without the
// second, a request that does emit one gets token counts with no `cost`.
export function getOpenRouterModel(modelId: string): LanguageModel {
  const apiKey = getApiKey("OPENROUTER_API_KEY");
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Run: seri config set OPENROUTER_API_KEY <your-key>",
    );
  }
  return createOpenRouter({ apiKey, compatibility: "strict" })(modelId, {
    usage: { include: true },
  });
}
