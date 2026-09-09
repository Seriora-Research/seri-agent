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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePricing(value: unknown): ModelCatalogEntry["pricing"] {
  if (!isPlainObject(value)) return undefined;
  const input = finiteNumber(value.input);
  const output = finiteNumber(value.output);
  if (input === undefined || output === undefined) return undefined;
  const pricing: NonNullable<ModelCatalogEntry["pricing"]> = {
    inputPerMTok: input,
    outputPerMTok: output,
  };
  const cacheRead = finiteNumber(value.cache_read);
  if (cacheRead !== undefined) pricing.cacheReadPerMTok = cacheRead;
  const cacheWrite = finiteNumber(value.cache_write);
  if (cacheWrite !== undefined) pricing.cacheWritePerMTok = cacheWrite;
  return pricing;
}

function parseReasoningOption(value: unknown): ReasoningOption | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.type === "toggle") return { type: "toggle" };
  if (value.type === "budget_tokens") return { type: "budget_tokens" };
  if (value.type === "effort") {
    if (!Array.isArray(value.values) || value.values.length === 0) return undefined;
    if (!value.values.every((item): item is string => typeof item === "string")) return undefined;
    return { type: "effort", values: value.values };
  }
  return undefined;
}

function parseReasoningOptions(value: unknown): ReasoningOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: ReasoningOption[] = [];
  for (const item of value) {
    const option = parseReasoningOption(item);
    if (option !== undefined) options.push(option);
  }
  return options.length > 0 ? options : undefined;
}

function parseModel(provider: ModelProvider, raw: unknown): ModelCatalogEntry | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name)) return undefined;
  if (typeof raw.tool_call !== "boolean") return undefined;
  if (!isPlainObject(raw.limit)) return undefined;
  const contextWindow = finiteNumber(raw.limit.context);
  const maxOutputTokens = finiteNumber(raw.limit.output);
  if (contextWindow === undefined || maxOutputTokens === undefined) return undefined;

  return {
    id: raw.id,
    provider,
    displayName: raw.name,
    family: typeof raw.family === "string" ? raw.family : null,
    contextWindow,
    maxOutputTokens,
    toolCall: raw.tool_call,
    reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : false,
    reasoningOptions: parseReasoningOptions(raw.reasoning_options),
    pricing: parsePricing(raw.cost),
  };
}

export function mapRawCatalog(raw: unknown): ModelCatalogEntry[] {
  if (!isPlainObject(raw)) {
    throw new Error("catalog JSON root is not a plain object");
  }
  const entries: ModelCatalogEntry[] = [];
  for (const provider of CATALOG_PROVIDERS) {
    const providerValue = raw[provider];
    if (!isPlainObject(providerValue)) continue;
    const models = providerValue.models;
    if (!isPlainObject(models)) continue;
    for (const model of Object.values(models)) {
      const entry = parseModel(provider, model);
      if (entry !== undefined) entries.push(entry);
    }
  }
  const usable = filterCatalogEntries(entries);
  if (usable.length === 0) {
    throw new Error("catalog JSON had no usable entries");
  }
  return usable;
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
        const raw: unknown = await response.json();
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
