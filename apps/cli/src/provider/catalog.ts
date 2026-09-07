import {
  loadCatalog,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelProvider,
} from "@seri/model-catalog";
import { type CodexListedModel, listCodexModels } from "../auth/codexRefresh";
import { hasXaiSubscription, loadXaiSubscription } from "../auth/xaiAuthStore";
import { xaiAuthedFetch } from "../auth/xaiRefresh";
import { printWarning } from "../cli/output";
import { messageOf } from "../errors";
import bundledManifest from "./catalog-manifest.json";
import { codexSubscriptionActive } from "./subscriptions";
import { grokCatalogHeaders, grokProxyBaseUrl } from "./xai";

// bun inlines a JSON import at build time; it needs no with { type: "file" }.
const FALLBACK_MANIFEST = bundledManifest as ModelCatalog;

export function catalogWithFallback(
  live: ModelCatalog,
  configured: ReadonlySet<ModelProvider>,
): ModelCatalog {
  const liveProviders = new Set(live.entries.map((entry) => entry.provider));
  const backfill = FALLBACK_MANIFEST.entries.filter(
    (entry) => configured.has(entry.provider) && !liveProviders.has(entry.provider),
  );
  return backfill.length === 0 ? live : { ...live, entries: [...live.entries, ...backfill] };
}

let warnedFallback = false;
let codexPlanCatalogApplied = false;
let warnedCodexOverlay = false;

export function resetFallbackWarning(): void {
  warnedFallback = false;
}

export function isCodexPlanCatalogApplied(): boolean {
  return codexPlanCatalogApplied;
}

export function resetCodexPlanCatalogApplied(): void {
  codexPlanCatalogApplied = false;
  warnedCodexOverlay = false;
}

export function prewarmModelCatalog(): void {
  void loadCatalog(FALLBACK_MANIFEST, fetch);
}

export async function getModelCatalog(
  fetchFn: typeof fetch = fetch,

  sink?: (line: string) => void,
  configDir?: string,
): Promise<ModelCatalog> {
  const catalog = await loadCatalog(FALLBACK_MANIFEST, fetchFn);
  if (catalog === FALLBACK_MANIFEST && !warnedFallback) {
    warnedFallback = true;

    printWarning(
      process.env.SERI_DISABLE_MODELS_FETCH
        ? "models.dev fetch disabled by SERI_DISABLE_MODELS_FETCH; using the bundled model catalog"
        : "could not reach models.dev; using the bundled model catalog",
      sink,
    );
  }
  let merged = catalog;
  if (configDir !== undefined && hasXaiSubscription(configDir)) {
    merged = await mergeGrokSubscriptionModels(merged, configDir, fetchFn);
  }
  return withCodexSubscriptionCatalog(
    merged,
    sink,
    () => listCodexModels({ configDir, fetchFn }),
    configDir,
  );
}

const CODEX_DEFAULT_CONTEXT = 272_000;
const CODEX_DEFAULT_OUTPUT = 16_384;

export function overlayCodexModels(
  catalog: ModelCatalog,
  models: readonly CodexListedModel[],
): ModelCatalog {
  if (models.length === 0) return catalog;
  const existingById = new Map(
    catalog.entries
      .filter((entry) => entry.provider === "openai")
      .map((entry) => [entry.id, entry]),
  );
  const openai: ModelCatalogEntry[] = models.map((model) => {
    const existing = existingById.get(model.id);
    const reasoningValues = model.supportedReasoningEfforts;
    return {
      id: model.id,
      provider: "openai",
      displayName: model.displayName,
      family: existing?.family ?? null,
      contextWindow: existing?.contextWindow ?? CODEX_DEFAULT_CONTEXT,
      maxOutputTokens: existing?.maxOutputTokens ?? CODEX_DEFAULT_OUTPUT,
      toolCall: existing?.toolCall ?? true,
      reasoning: reasoningValues.length > 0 || (existing?.reasoning ?? false),
      reasoningOptions:
        reasoningValues.length > 0
          ? [{ type: "effort", values: reasoningValues }]
          : existing?.reasoningOptions,
      pricing: undefined,
    };
  });
  return {
    ...catalog,
    entries: [...catalog.entries.filter((entry) => entry.provider !== "openai"), ...openai],
  };
}

export async function catalogForModelPicker(
  current: ModelCatalog,
  configDir: string,
  fetchFn: typeof fetch = fetch,
  sink?: (line: string) => void,
): Promise<ModelCatalog> {
  if (!codexSubscriptionActive(configDir) || isCodexPlanCatalogApplied()) {
    return current;
  }
  return withCodexSubscriptionCatalog(
    current,
    sink,
    () => listCodexModels({ configDir, fetchFn }),
    configDir,
  );
}

export async function withCodexSubscriptionCatalog(
  catalog: ModelCatalog,
  sink?: (line: string) => void,
  listFn: () => Promise<readonly CodexListedModel[]> = listCodexModels,
  configDir?: string,
): Promise<ModelCatalog> {
  if (!codexSubscriptionActive(configDir)) {
    codexPlanCatalogApplied = false;
    return catalog;
  }
  try {
    const models = await listFn();
    if (models.length === 0) {
      codexPlanCatalogApplied = false;
      warnCodexOverlay(
        "ChatGPT plan model list was empty; showing the API catalog. Included models may be missing or mispriced until the next refresh.",
        sink,
      );
      return catalog;
    }
    const overlaid = overlayCodexModels(catalog, models);
    codexPlanCatalogApplied = true;
    return overlaid;
  } catch (err) {
    codexPlanCatalogApplied = false;
    warnCodexOverlay(
      `could not load the ChatGPT plan model list (${messageOf(err)}); showing the API catalog. Included models may be missing or mispriced until the next refresh.`,
      sink,
    );
    return catalog;
  }
}

function warnCodexOverlay(message: string, sink?: (line: string) => void): void {
  if (warnedCodexOverlay) return;
  warnedCodexOverlay = true;
  printWarning(message, sink);
}

function stubGrokEntry(id: string): ModelCatalogEntry {
  return {
    id,
    provider: "xai",
    displayName: id,
    family: "grok",
    contextWindow: 131072,
    maxOutputTokens: 16384,
    toolCall: true,
    reasoning: true,
    pricing: undefined,
  };
}

export function idsFromGrokModelsPayload(body: unknown): string[] {
  if (Array.isArray(body)) {
    return body.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  if (body === null || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const list = record.data ?? record.models;
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const item of list) {
    if (typeof item === "string" && item.length > 0) ids.push(item);
    else if (
      item !== null &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string" &&
      (item as { id: string }).id.length > 0
    ) {
      ids.push((item as { id: string }).id);
    }
  }
  return ids;
}

export function mergeGrokSubscriptionCatalog(
  catalog: ModelCatalog,
  proxyIds: string[],
): ModelCatalog {
  if (proxyIds.length === 0) return catalog;
  const existing = new Map(
    catalog.entries.filter((entry) => entry.provider === "xai").map((entry) => [entry.id, entry]),
  );
  const xaiEntries = proxyIds.map((id) => existing.get(id) ?? stubGrokEntry(id));
  return {
    ...catalog,
    entries: [...catalog.entries.filter((entry) => entry.provider !== "xai"), ...xaiEntries],
  };
}

async function mergeGrokSubscriptionModels(
  catalog: ModelCatalog,
  configDir: string,
  fetchFn: typeof fetch,
): Promise<ModelCatalog> {
  try {
    const authed = xaiAuthedFetch(configDir, fetchFn);
    const accountId = loadXaiSubscription(configDir)?.accountId;
    const response = await authed(`${grokProxyBaseUrl(configDir)}/models`, {
      headers: grokCatalogHeaders(accountId),
    });
    if (!response.ok) return catalog;
    const body: unknown = JSON.parse(await response.text());
    return mergeGrokSubscriptionCatalog(catalog, idsFromGrokModelsPayload(body));
  } catch {
    return catalog;
  }
}
