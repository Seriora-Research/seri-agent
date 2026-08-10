import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";

// No default for modelId, matching groq.ts: the caller (provider/model.ts) is the single
// authority on what id to construct with.
//
// `compatibility: "strict"` and `usage: { include: true }` are OpenRouter's own documented pair
// for usage accounting (https://openrouter.ai/docs/use-cases/usage-accounting) — confirmed against
// the installed @openrouter/ai-sdk-provider@3.0.0's compiled source (dist/index.js), not just its
// .d.ts: `strict` is what makes the provider send `stream_options.include_usage: true` on a
// streaming request (dist/index.js:3888-3890); `usage.include` is a separate top-level `usage`
// field OpenRouter itself reads to decide whether to attach `cost` to the response's usage object.
// Kept even though a live check (2026-08-09, live API, gpt-oss-20b) found `providerMetadata
// .openrouter.usage.cost` already populated with NEITHER setting present — this SDK version's
// default "compatible" mode returned a full usage+cost object unprompted, contradicting the
// "OpenRouter likely never returns cost without opting in" premise this was written to fix. Left in
// anyway: it is still the officially documented way to REQUEST usage accounting rather than rely on
// undocumented default behaviour that could change upstream, it costs nothing measured (same cost
// data came back with both settings applied), and it is what a reader following OpenRouter's own
// docs would expect to see here. Do not read the two `dist/index.js` line-number claims above as
// "this is why cost was missing before" — that specific causal claim was not observed; only the
// settings' own existence and effect on the outbound request body were confirmed.
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
