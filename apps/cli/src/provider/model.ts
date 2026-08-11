import type { ModelProvider } from "@seri/model-catalog";
import type { LanguageModel } from "ai";
import { getAnthropicModel as getAnthropicModelReal } from "./anthropic";
import { getGoogleModel as getGoogleModelReal } from "./google";
import { getGroqModel as getGroqModelReal } from "./groq";
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
export function getModel(
  id: string,
  provider: ModelProvider,
  sessionId: string,
  deps: ModelDeps = {},
): LanguageModel {
  const getGroqModelFn = deps.getGroqModel ?? getGroqModelReal;
  const getOpenRouterModelFn = deps.getOpenRouterModel ?? getOpenRouterModelReal;
  const getAnthropicModelFn = deps.getAnthropicModel ?? getAnthropicModelReal;
  const getOpenAIModelFn = deps.getOpenAIModel ?? getOpenAIModelReal;
  const getGoogleModelFn = deps.getGoogleModel ?? getGoogleModelReal;
  switch (provider) {
    case "groq":
      return getGroqModelFn(id);
    case "openrouter":
      return getOpenRouterModelFn(id, sessionId);
    case "anthropic":
      return getAnthropicModelFn(id);
    case "openai":
      return getOpenAIModelFn(id);
    case "google":
      return getGoogleModelFn(id);
    default:
      // provider is `never` here if it only ever holds the five ModelProvider members above —
      // but this value can also come from JSON.parse (session.ts), which no type system can
      // guarantee.
      throw new Error(`Unknown model provider: ${JSON.stringify(provider)}`);
  }
}
