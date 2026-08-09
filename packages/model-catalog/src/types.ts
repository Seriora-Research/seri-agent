// The shared vocabulary both apps/cli and (later) apps/portal type against — verbatim from
// research-spec.md's question (b), mirroring models.dev's own schema rather than either
// provider's raw API shape.
export type ModelProvider = "groq" | "openrouter";

export type ModelCatalogEntry = {
  id: string; // e.g. "llama-3.3-70b-versatile" (groq) or "meta-llama/llama-3.3-70b-instruct" (openrouter)
  provider: ModelProvider;
  displayName: string; // models.dev `name`
  family: string; // models.dev `family` — verbatim from upstream, not a hand-maintained enum
  contextWindow: number; // models.dev `limit.context`
  maxOutputTokens: number; // models.dev `limit.output`
  toolCall: boolean; // models.dev `tool_call` — explicit flag, not inferred from supported_parameters
  reasoning: boolean; // models.dev `reasoning`
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
