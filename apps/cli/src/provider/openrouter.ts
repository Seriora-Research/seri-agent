import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";

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
// `session_id` is passed via `extraBody`, not a typed field: the installed
// @openrouter/ai-sdk-provider@3.0.0's settings types have no `session_id` option anywhere —
// only `extraBody?: Record<string, unknown>` on `OpenRouterSharedSettings`, which is what
// `extraBody` below actually reaches. This is OpenRouter's documented sticky-routing mechanism
// (https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/): requests sharing a
// `session_id` land on the same upstream backend, which is what lets its prompt cache hit across
// turns. The same doc warns the two routing mechanisms conflict — "if you set `provider.order`
// yourself, your order wins over sticky routing" — so a future contributor adding `provider.order`
// here must remove `session_id` first, or vice versa, not combine them. Dynamic multi-backend
// provider pinning (deriving a `provider.order` pin per model via OpenRouter's
// `/models/{author}/{slug}/endpoints` API) was researched and deliberately not built here:
// correct pinning gets backend consistency but not a cache guarantee (2/2 tested backends showed
// zero cache activity despite a verified-correct pin, 2026-08-10), and no comparable harness has
// shipped the cache-hit-specific version of this.
// `apiKey` defaults to today's lookup but can be overridden — see anthropic.ts's own comment on
// why (validate.ts's probe call, D5).
export function getOpenRouterModel(
  modelId: string,
  sessionId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.openrouter),
): LanguageModel {
  if (!apiKey) throw missingKeyError("openrouter");
  return createOpenRouter({ apiKey, compatibility: "strict" })(modelId, {
    extraBody: { session_id: sessionId },
  });
}
