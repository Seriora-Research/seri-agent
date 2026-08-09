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
export function getModel(
  id: string,
  provider: "groq" | "openrouter",
  deps: ModelDeps = {},
): LanguageModel {
  const getGroqModelFn = deps.getGroqModel ?? getGroqModelReal;
  const getOpenRouterModelFn = deps.getOpenRouterModel ?? getOpenRouterModelReal;
  return provider === "groq" ? getGroqModelFn(id) : getOpenRouterModelFn(id);
}
