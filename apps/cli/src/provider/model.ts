import type { ModelProvider } from "@seri/model-catalog";
import type { LanguageModel } from "ai";
import { getApiKey } from "../config/config";
import { getAnthropicModel as getAnthropicModelReal } from "./anthropic";
import { getGoogleModel as getGoogleModelReal } from "./google";
import { getGroqModel as getGroqModelReal } from "./groq";
import { PROVIDER_API_KEY_NAMES } from "./keys";
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
    case "groq":
      return getGroqModelFn(id, getApiKey(PROVIDER_API_KEY_NAMES.groq, configDir));
    case "openrouter":
      return getOpenRouterModelFn(
        id,
        sessionId,
        getApiKey(PROVIDER_API_KEY_NAMES.openrouter, configDir),
      );
    case "anthropic":
      return getAnthropicModelFn(id, getApiKey(PROVIDER_API_KEY_NAMES.anthropic, configDir));
    case "openai":
      return getOpenAIModelFn(id, getApiKey(PROVIDER_API_KEY_NAMES.openai, configDir));
    case "google":
      return getGoogleModelFn(id, getApiKey(PROVIDER_API_KEY_NAMES.google, configDir));
    default:
      // provider is `never` here if it only ever holds the five ModelProvider members above —
      // but this value can also come from JSON.parse (session.ts), which no type system can
      // guarantee.
      throw new Error(`Unknown model provider: ${JSON.stringify(provider)}`);
  }
}
