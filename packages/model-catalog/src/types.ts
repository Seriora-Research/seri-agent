


export type ModelProvider = "groq" | "openrouter" | "anthropic" | "openai" | "google" | "xai";





export type ReasoningOption =
  | { type: "effort"; values: string[] }
  | { type: "toggle" }
  | { type: "budget_tokens" };

export type ModelCatalogEntry = {
  id: string;
  provider: ModelProvider;
  displayName: string;





  family: string | null;
  contextWindow: number;
  maxOutputTokens: number;
  toolCall: boolean;
  reasoning: boolean;
  reasoningOptions?: ReasoningOption[];

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
