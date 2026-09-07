import { fetchWithTimeout } from "./fetchWithTimeout";
import { filterCatalogEntries } from "./filter";
import type { ModelCatalog, ModelCatalogEntry, ModelProvider, ReasoningOption } from "./types";

const MODELS_DEV_URL = "https://models.dev/api.json";
// models.dev has no documented rate limit; this bounds an unbounded hang, not a measured budget.
const FETCH_TIMEOUT_MS = 10_000;






export const CATALOG_PROVIDERS: readonly ModelProvider[] = [
  "groq",
  "openrouter",
  "anthropic",
  "openai",
  "google",


  "xai",
];

export const GATEWAY_PROVIDER: ModelProvider = "openrouter";

type RawModel = {
  id: string;
  name: string;


  family: string | null;
  tool_call: boolean;
  reasoning: boolean;
  reasoning_options?: ReasoningOption[];
  limit: { context: number; output: number };
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
};

export type RawCatalogResponse = Record<string, { models: Record<string, RawModel> }>;

function toEntry(provider: ModelProvider, raw: RawModel): ModelCatalogEntry {
  return {
    id: raw.id,
    provider,
    displayName: raw.name,
    family: raw.family,
    contextWindow: raw.limit.context,
    maxOutputTokens: raw.limit.output,
    toolCall: raw.tool_call,
    reasoning: raw.reasoning,
    reasoningOptions: raw.reasoning_options,
    pricing: raw.cost
      ? {
          inputPerMTok: raw.cost.input,
          outputPerMTok: raw.cost.output,
          cacheReadPerMTok: raw.cost.cache_read,
          cacheWritePerMTok: raw.cost.cache_write,
        }
      : undefined,
  };
}



export function mapRawCatalog(raw: RawCatalogResponse): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const provider of CATALOG_PROVIDERS) {
    const models = raw[provider]?.models;
    if (!models) continue;
    for (const model of Object.values(models)) entries.push(toEntry(provider, model));
  }
  return filterCatalogEntries(entries);
}









let cachedPromise: Promise<ModelCatalog> | undefined;







export function resetCatalogCache(): void {
  cachedPromise = undefined;
}






export async function loadCatalog(
  manifest: ModelCatalog,
  fetchFn: typeof fetch = fetch,
): Promise<ModelCatalog> {
  if (cachedPromise) return cachedPromise;

  cachedPromise = (async () => {
    if (process.env.SERI_DISABLE_MODELS_FETCH) {
      return manifest;
    }

    try {
      return await fetchWithTimeout(fetchFn, MODELS_DEV_URL, FETCH_TIMEOUT_MS, async (response) => {
        if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
        const raw = (await response.json()) as RawCatalogResponse;
        return { fetchedAt: new Date().toISOString(), entries: mapRawCatalog(raw) };
      });
    } catch {
      return manifest;
    }
  })();
  return cachedPromise;
}

export function findCatalogEntry(
  catalog: ModelCatalog,
  id: string,
  provider: ModelProvider,
): ModelCatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.id === id && entry.provider === provider);
}






export function isZeroPriceEntry(entry: ModelCatalogEntry | undefined): boolean {
  return (
    entry?.pricing !== undefined &&
    entry.pricing.inputPerMTok === 0 &&
    entry.pricing.outputPerMTok === 0
  );
}
