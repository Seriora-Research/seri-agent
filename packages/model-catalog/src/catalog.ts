import { filterCatalogEntries } from "./filter";
import type { ModelCatalog, ModelCatalogEntry, ModelProvider } from "./types";

const MODELS_DEV_URL = "https://models.dev/api.json";
// ~10s, matching opencode's own value (research-spec.md) — models.dev has no documented rate
// limit, so this is the mitigation for an unbounded-hang request, not a measured budget.
const FETCH_TIMEOUT_MS = 10_000;

// seri only has these five providers — every other key in models.dev's response is ignored.
// Exported (not just used by mapRawCatalog below) so it is the single source of truth a
// consumer's own provider-membership check can derive from instead of maintaining a second,
// independently-hardcoded list that can silently drift out of sync with this one — apps/cli's
// provider/defaults.ts's isModelProvider is the current example.
export const CATALOG_PROVIDERS: readonly ModelProvider[] = [
  "groq",
  "openrouter",
  "anthropic",
  "openai",
  "google",
];

type RawModel = {
  id: string;
  name: string;
  // Code-review finding: some real models.dev entries carry no family — was typed `string`
  // unconditionally, which just meant an upstream `null` came through as a lie, not an error.
  family: string | null;
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

// Caches the in-flight PROMISE, not just the resolved value (code-review finding, PR #91):
// caching only the resolved `ModelCatalog` left a window, between a caller's first `loadCatalog`
// call and that fetch actually settling, where a SECOND concurrent caller (e.g.
// byok-guided-setup-default-model's own decline path, which can resolve before run()'s own
// unawaited `getModelCatalog()` call has settled) would see nothing cached yet and start its own,
// fully independent fetch to models.dev. Assigning `cachedPromise` synchronously, before this
// function's own first `await`, is what closes that window: two calls in the same tick both see
// the same promise, not just two calls that happen to already be resolved.
let cachedPromise: Promise<ModelCatalog> | undefined;

// Test-only reset for the process-lifetime cache below. Exported from index.ts (not just this
// package's own tests via a direct relative import) so a CONSUMER's test suite — apps/cli's
// catalog.test.ts, notably — can reset the cache too: apps/cli's own getModelCatalog wraps
// loadCatalog and is exercised by many tests in the same `bun test` process, so a test that needs
// to observe a genuine fetch-fails-and-falls-back path has to clear whatever an earlier test
// already cached first.
export function resetCatalogCache(): void {
  cachedPromise = undefined;
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
  if (cachedPromise) return cachedPromise;

  const promise = (async () => {
    if (process.env.SERI_DISABLE_MODELS_FETCH) {
      return manifest;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchFn(MODELS_DEV_URL, { signal: controller.signal });
      if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
      const raw = (await response.json()) as RawCatalogResponse;
      return { fetchedAt: new Date().toISOString(), entries: mapRawCatalog(raw) };
    } catch {
      return manifest;
    } finally {
      clearTimeout(timer);
    }
  })();
  cachedPromise = promise;
  // A fallback result (this promise resolving to `manifest` itself, the same-reference check
  // callers use to detect it) must not be cached for the process lifetime the way a genuine
  // fetched catalog is — apps/server's own EMPTY_MANIFEST fallback would otherwise fail every
  // Free-tier request's isZeroPriceModel check forever after a single transient fetch failure.
  // Clearing the cache here makes the NEXT loadCatalog call the retry, while every caller
  // already awaiting THIS promise (the concurrent-callers race the caching above closes) still
  // gets the fallback it needs right now.
  void promise.then((result) => {
    if (result === manifest) cachedPromise = undefined;
  });
  return promise;
}

export function findCatalogEntry(
  catalog: ModelCatalog,
  id: string,
  provider: ModelProvider,
): ModelCatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.id === id && entry.provider === provider);
}
