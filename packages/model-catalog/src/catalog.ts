import { filterCatalogEntries } from "./filter";
import type { ModelCatalog, ModelCatalogEntry, ModelProvider } from "./types";

const MODELS_DEV_URL = "https://models.dev/api.json";
// ~10s, matching opencode's own value (research-spec.md) — models.dev has no documented rate
// limit, so this is the mitigation for an unbounded-hang request, not a measured budget.
const FETCH_TIMEOUT_MS = 10_000;

// seri only has these two providers — every other key in models.dev's response is ignored.
const CATALOG_PROVIDERS: readonly ModelProvider[] = ["groq", "openrouter"];

type RawModel = {
  id: string;
  name: string;
  family: string;
  tool_call: boolean;
  reasoning: boolean;
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

// Shared by the runtime loader below and generate.ts, so the bundled fallback and the live
// fetch path can never curate differently.
export function mapRawCatalog(raw: RawCatalogResponse): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const provider of CATALOG_PROVIDERS) {
    const models = raw[provider]?.models;
    if (!models) continue;
    for (const model of Object.values(models)) entries.push(toEntry(provider, model));
  }
  return filterCatalogEntries(entries);
}

let cached: ModelCatalog | undefined;

// Test-only reset for the process-lifetime cache below. Exported from index.ts (not just this
// package's own tests via a direct relative import) so a CONSUMER's test suite — apps/cli's
// catalog.test.ts, notably — can reset the cache too: apps/cli's own getModelCatalog wraps
// loadCatalog and is exercised by many tests in the same `bun test` process, so a test that needs
// to observe a genuine fetch-fails-and-falls-back path has to clear whatever an earlier test
// already cached first.
export function resetCatalogCache(): void {
  cached = undefined;
}

// Fetches models.dev live and falls back to the caller-supplied `manifest` on timeout, network
// failure, a non-200 response, or SERI_DISABLE_MODELS_FETCH being set. No file I/O here: apps/cli
// and apps/portal stage their fallback asset completely differently, so that stays the caller's
// concern. On fallback, the returned catalog is `manifest` itself (same reference) so a caller can
// tell fallback happened with `result === manifest`, e.g. to print a warning once.
export async function loadCatalog(
  manifest: ModelCatalog,
  fetchFn: typeof fetch = fetch,
): Promise<ModelCatalog> {
  if (cached) return cached;

  if (process.env.SERI_DISABLE_MODELS_FETCH) {
    cached = manifest;
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(MODELS_DEV_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
    const raw = (await response.json()) as RawCatalogResponse;
    cached = { fetchedAt: new Date().toISOString(), entries: mapRawCatalog(raw) };
  } catch {
    cached = manifest;
  } finally {
    clearTimeout(timer);
  }
  return cached;
}

export function findCatalogEntry(
  catalog: ModelCatalog,
  id: string,
  provider: ModelProvider,
): ModelCatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.id === id && entry.provider === provider);
}
