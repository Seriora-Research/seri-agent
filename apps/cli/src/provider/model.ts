import type { ModelProvider } from "@seri/model-catalog";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { getAnthropicModel as getAnthropicModelReal } from "./anthropic";
import { getGoogleModel as getGoogleModelReal } from "./google";
import { getGroqModel as getGroqModelReal } from "./groq";
import { missingKeyError, PROVIDER_API_KEY_NAMES } from "./keys";
import { getOpenAIModel as getOpenAIModelReal } from "./openai";
import { getOpenRouterModel as getOpenRouterModelReal } from "./openrouter";

// Optional injected fns, mirroring cli.ts's own CliDeps (all five fields, same names) — lets
// tests exercise the dispatch without constructing a real provider.
type ModelDeps = {
  getGroqModel?: typeof getGroqModelReal;
  getOpenRouterModel?: typeof getOpenRouterModelReal;
  getAnthropicModel?: typeof getAnthropicModelReal;
  getOpenAIModel?: typeof getOpenAIModelReal;
  getGoogleModel?: typeof getGoogleModelReal;
};

// The one dispatch point cli.ts's prepareSession/runTurn call instead of getGroqModel directly
// (Slice 4 wires that in — this commit only adds the dispatcher itself).
//
// Code-review finding: `provider` used to be treated as `"groq" | "openrouter"` by a bare
// ternary — any non-"groq" string (a session.json a stale seri version wrote, a hand edit, a
// future provider value read by an older binary) silently fell into the OpenRouter branch
// instead of erroring. `session.ts`'s own `loadSession` is a bare `JSON.parse`, so nothing
// upstream validates this either. A `switch` over the real `ModelProvider` union makes an
// unrecognized value a thrown error naming the bad value, not a wrong provider silently called.
//
// `configDir` (code-review finding, PR #73, round 2, item #2): cli.ts resolves routing against
// `deps.authConfigDir ?? getConfigDir()`, but this dispatcher used to call each get<X>Model with
// no apiKey override, so their own default params (`apiKey = getApiKey(...)`, no configDir) read
// the REAL getConfigDir() instead — any `run(argv, deps)` caller with a non-default
// `authConfigDir` (a test, an embedder) got told "routing … (your key)" by resolveRoute and then
// hit missingKeyError anyway, because the actual construction call read a different directory.
// Resolving the apiKey here, from the SAME configDir cli.ts already resolved routing against, and
// passing it through explicitly is what keeps the two in sync — the same seam validate.ts's own
// probe call (D5) already uses each get<X>Model's `apiKey` override for.
//
// Bug fixed here (code-review, PR #73, round 3, item #2): each get<X>Model's own `apiKey`
// parameter has a DEFAULT (its own `apiKey = getApiKey(NAME)`, no configDir), and passing an
// explicit `undefined` argument — exactly what the round 2 fix above did whenever the resolved
// key was genuinely absent — RE-TRIGGERS that default in JS (a default param fires on `undefined`
// whether it's omitted or passed explicitly). So a provider unconfigured at the CALLER's configDir
// but configured in the ambient default one silently authenticated with the wrong key instead of
// throwing missingKeyError. Each case below now checks this itself and throws BEFORE calling the
// real constructor — but only when calling the REAL one (`fn === real`): an INJECTED replacement
// (every test in this file) owns its own credential handling entirely, which is the whole point of
// injecting one, and must not be forced to also fake an API key just to avoid a throw that has
// nothing to do with what it's testing.
export function getModel(
  id: string,
  provider: ModelProvider,
  sessionId: string,
  deps: ModelDeps = {},
  configDir?: string,
): LanguageModel {
  const getGroqModelFn = deps.getGroqModel ?? getGroqModelReal;
  const getOpenRouterModelFn = deps.getOpenRouterModel ?? getOpenRouterModelReal;
  const getAnthropicModelFn = deps.getAnthropicModel ?? getAnthropicModelReal;
  const getOpenAIModelFn = deps.getOpenAIModel ?? getOpenAIModelReal;
  const getGoogleModelFn = deps.getGoogleModel ?? getGoogleModelReal;
  switch (provider) {
    case "groq": {
      const apiKey = getApiKey(PROVIDER_API_KEY_NAMES.groq, configDir);
      if (getGroqModelFn === getGroqModelReal && apiKey === undefined) {
        throw missingKeyError("groq");
      }
      return getGroqModelFn(id, apiKey);
    }
    case "openrouter": {
      const apiKey = getApiKey(PROVIDER_API_KEY_NAMES.openrouter, configDir);
      if (getOpenRouterModelFn === getOpenRouterModelReal && apiKey === undefined) {
        throw missingKeyError("openrouter");
      }
      return getOpenRouterModelFn(id, sessionId, apiKey);
    }
    case "anthropic": {
      const apiKey = getApiKey(PROVIDER_API_KEY_NAMES.anthropic, configDir);
      if (getAnthropicModelFn === getAnthropicModelReal && apiKey === undefined) {
        throw missingKeyError("anthropic");
      }
      return getAnthropicModelFn(id, apiKey);
    }
    case "openai": {
      const apiKey = getApiKey(PROVIDER_API_KEY_NAMES.openai, configDir);
      if (getOpenAIModelFn === getOpenAIModelReal && apiKey === undefined) {
        throw missingKeyError("openai");
      }
      return getOpenAIModelFn(id, apiKey);
    }
    case "google": {
      const apiKey = getApiKey(PROVIDER_API_KEY_NAMES.google, configDir);
      if (getGoogleModelFn === getGoogleModelReal && apiKey === undefined) {
        throw missingKeyError("google");
      }
      return getGoogleModelFn(id, apiKey);
    }
    default:
      // provider is `never` here if it only ever holds the five ModelProvider members above —
      // but this value can also come from JSON.parse (session.ts), which no type system can
      // guarantee.
      throw new Error(`Unknown model provider: ${JSON.stringify(provider)}`);
  }
}
