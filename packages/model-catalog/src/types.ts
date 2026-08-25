// The shared vocabulary both apps/cli and (later) apps/portal type against — verbatim from
// research-spec.md's question (b), mirroring models.dev's own schema rather than either
// provider's raw API shape.
export type ModelProvider = "groq" | "openrouter" | "anthropic" | "openai" | "google";

// models.dev `reasoning_options` — always an array, can carry more than one entry per model
// (e.g. GLM 5.2 lists toggle+effort+budget_tokens together). `budget_tokens` has no min/max/
// default sub-fields in the live catalog today; callers offering a user-facing tier list should
// treat a bare `{type: "budget_tokens"}` entry as not offering one (see apps/cli's reasoning.ts).
export type ReasoningOption =
  | { type: "effort"; values: string[] }
  | { type: "toggle" }
  | { type: "budget_tokens" };

export type ModelCatalogEntry = {
  id: string; // e.g. "llama-3.3-70b-versatile" (groq) or "meta-llama/llama-3.3-70b-instruct" (openrouter)
  provider: ModelProvider;
  displayName: string; // models.dev `name`
  // models.dev `family` — verbatim from upstream, not a hand-maintained enum. `null`, not always
  // a string: code-review finding, some upstream entries carry no family. Callers reading this
  // must handle the null case explicitly (apps/cli's `matchesFilter` is the current example) —
  // the type used to claim `string` unconditionally, which only worked because the one call site
  // happened to guard it anyway, not because the type was accurate.
  family: string | null;
  contextWindow: number; // models.dev `limit.context`
  maxOutputTokens: number; // models.dev `limit.output`
  toolCall: boolean; // models.dev `tool_call` — explicit flag, not inferred from supported_parameters
  reasoning: boolean; // models.dev `reasoning`
  reasoningOptions?: ReasoningOption[]; // models.dev `reasoning_options`
  // USD per 1,000,000 tokens, numeric (models.dev's unit).
  pricing:
    | {
        inputPerMTok: number;
        outputPerMTok: number;
        cacheReadPerMTok?: number;
        cacheWritePerMTok?: number;
      }
    | undefined;
};

export type ModelCatalog = { fetchedAt: string; entries: ModelCatalogEntry[] };
