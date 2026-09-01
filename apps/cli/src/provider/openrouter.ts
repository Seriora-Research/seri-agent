import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";
import { loadOpenRouterPin } from "./sampling";

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
// yourself, your order wins over sticky routing" — so a pin (`SERI_OPENROUTER_PROVIDER`) and
// `session_id` are alternatives, never combined. Pinning is opt-in because a verified-correct
// pin has been seen with no prompt-cache activity (2/2 backends, 2026-08-10).
// `apiKey` defaults to today's lookup but can be overridden — see anthropic.ts's own comment on
// why (validate.ts's probe call, D5).
export function getOpenRouterModel(
  modelId: string,
  sessionId: string,
  apiKey = getApiKey(PROVIDER_API_KEY_NAMES.openrouter),
  configDir?: string,
): LanguageModel {
  if (!apiKey) throw missingKeyError("openrouter");
  // Pin and sticky routing are mutually exclusive — OpenRouter's own docs, and
  // this file's comment above. A set pin wins; `session_id` stays the default.
  const pin = loadOpenRouterPin(configDir);
  const extraBody =
    pin === undefined
      ? { session_id: sessionId }
      : { provider: { order: pin, allow_fallbacks: false } };
  return createOpenRouter({ apiKey, compatibility: "strict" })(modelId, {
    extraBody,
  });
}
