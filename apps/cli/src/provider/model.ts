import type { ModelProvider } from "@seri/model-catalog";
import type { LanguageModel } from "ai";
import { getGroqModel as getGroqModelReal } from "./groq";
import { getOpenRouterModel as getOpenRouterModelReal } from "./openrouter";

// Optional injected fns, mirroring cli.ts's own CliDeps pattern — lets tests exercise the
// dispatch without constructing a real provider.
type ModelDeps = {
  getGroqModel?: typeof getGroqModelReal;
  getOpenRouterModel?: typeof getOpenRouterModelReal;
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
  switch (provider) {
    case "groq":
      return getGroqModelFn(id);
    case "openrouter":
      return getOpenRouterModelFn(id, sessionId);
    default:
      // provider is `never` here if ModelProvider only ever has "groq"/"openrouter" — but this
      // value can also come from JSON.parse (session.ts), which no type system can guarantee.
      throw new Error(`Unknown model provider: ${JSON.stringify(provider)}`);
  }
}
