import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  findCatalogEntry,
  isZeroPriceEntry,
  loadCatalog,
  mapRawCatalog,
  type RawCatalogResponse,
  resetCatalogCache,
} from "../src/catalog";
import type { ModelCatalog, ModelCatalogEntry } from "../src/types";

const fallbackManifest: ModelCatalog = {
  fetchedAt: "2020-01-01T00:00:00Z",
  entries: [
    {
      id: "fallback-model",
      provider: "groq",
      displayName: "Fallback Model",
      family: "fallback",
      contextWindow: 1000,
      maxOutputTokens: 100,
      toolCall: true,
      reasoning: false,
      pricing: undefined,
    },
  ],
};

function rawApiResponse() {
  return {
    groq: {
      models: {
        "live-model": {
          id: "live-model",
          name: "Live Model",
          family: "live",
          tool_call: true,
          reasoning: false,
          limit: { context: 2000, output: 200 },
          cost: { input: 1, output: 2 },
        },
        "no-tools": {
          id: "no-tools",
          name: "No Tools",
          family: "live",
          tool_call: false,
          reasoning: false,
          limit: { context: 2000, output: 200 },
        },
      },
    },
    openrouter: { models: {} },
    anthropic: {
      models: {
        "claude-model": {
          id: "claude-model",
          name: "Claude Model",
          family: "claude",
          tool_call: true,
          reasoning: false,
          limit: { context: 3000, output: 300 },
          cost: { input: 3, output: 15 },
        },
        "claude-no-tools": {
          id: "claude-no-tools",
          name: "Claude No Tools",
          family: "claude",
          tool_call: false,
          reasoning: false,
          limit: { context: 3000, output: 300 },
        },
      },
    },
    // Ignored: seri only catalogs groq, openrouter, anthropic, openai and google, and
    // mapRawCatalog must not surface this.
    "other-provider": {
      models: {
        "ignored-model": {
          id: "ignored-model",
          name: "Ignored",
          family: "ignored",
          tool_call: true,
          reasoning: false,
          limit: { context: 1, output: 1 },
        },
      },
    },
  };
}

function fakeFetch(response: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({ ok, status, json: async () => response }) as unknown as Response) as unknown as typeof fetch;
}

describe("loadCatalog", () => {
  const originalDisableFlag = process.env.SERI_DISABLE_MODELS_FETCH;

  beforeEach(() => {
    resetCatalogCache();
    delete process.env.SERI_DISABLE_MODELS_FETCH;
  });

  afterEach(() => {
    if (originalDisableFlag === undefined) delete process.env.SERI_DISABLE_MODELS_FETCH;
    else process.env.SERI_DISABLE_MODELS_FETCH = originalDisableFlag;
  });

  test("fetch success: maps and filters live entries from the five cataloged providers, ignoring other provider keys", async () => {
    const catalog = await loadCatalog(fallbackManifest, fakeFetch(rawApiResponse()));

    expect(catalog.entries).toEqual([
      {
        id: "live-model",
        provider: "groq",
        displayName: "Live Model",
        family: "live",
        contextWindow: 2000,
        maxOutputTokens: 200,
        toolCall: true,
        reasoning: false,
        pricing: { inputPerMTok: 1, outputPerMTok: 2 },
      },
      {
        id: "claude-model",
        provider: "anthropic",
        displayName: "Claude Model",
        family: "claude",
        contextWindow: 3000,
        maxOutputTokens: 300,
        toolCall: true,
        reasoning: false,
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
      },
    ]);
  });

  test("fetch failure (network error): falls back to the caller-supplied manifest", async () => {
    const failingFetch: typeof fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const catalog = await loadCatalog(fallbackManifest, failingFetch);

    expect(catalog).toBe(fallbackManifest);
  });

  test("non-200 response: falls back to the caller-supplied manifest", async () => {
    const catalog = await loadCatalog(fallbackManifest, fakeFetch({}, false, 500));

    expect(catalog).toBe(fallbackManifest);
  });

  test("SERI_DISABLE_MODELS_FETCH set: skips fetch entirely and uses the fallback manifest", async () => {
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    let called = false;
    const fetchFn: typeof fetch = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const catalog = await loadCatalog(fallbackManifest, fetchFn);

    expect(called).toBe(false);
    expect(catalog).toBe(fallbackManifest);
  });

  test("caches in-memory for the process: a second call does not re-invoke fetch", async () => {
    let calls = 0;
    const fetchFn: typeof fetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => rawApiResponse() } as unknown as Response;
    }) as unknown as typeof fetch;

    await loadCatalog(fallbackManifest, fetchFn);
    await loadCatalog(fallbackManifest, fetchFn);

    expect(calls).toBe(1);
  });

  // Code-review finding, PR #91: the test above only proves a SECOND call made AFTER the first one
  // already resolved is a cache hit — it says nothing about two callers racing before either has
  // settled, which is the actual bug (a caller like byok-guided-setup-default-model's own decline
  // path can call loadCatalog again before run()'s own earlier, unawaited call has finished).
  // Neither `await` here: both calls fire in the same synchronous tick, before `fetchFn`'s own
  // pending promise resolves.
  test("two concurrent calls before either resolves share the same in-flight fetch, not two", async () => {
    let calls = 0;
    let resolveFetch!: (value: unknown) => void;
    const fetchFn: typeof fetch = (async () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveFetch = (json) =>
          resolve({ ok: true, status: 200, json: async () => json } as unknown as Response);
      });
    }) as unknown as typeof fetch;

    const first = loadCatalog(fallbackManifest, fetchFn);
    const second = loadCatalog(fallbackManifest, fetchFn);
    resolveFetch(rawApiResponse());
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(firstResult).toEqual(secondResult);
  });

  // A fallback result IS cached for the process lifetime too, same as a genuine fetch — a
  // caller with a usable, permanent fallback (apps/cli's bundled FALLBACK_MANIFEST) relies on
  // this to avoid re-attempting a live fetch (10s timeout) on every later call while offline. A
  // caller whose fallback is deliberately unusable (apps/server's EMPTY_MANIFEST) is responsible
  // for its own retry policy — see apps/server/lib/catalog.ts's resetCatalogCache() call.
  test("fetch failure: the fallback IS cached for the process — a later call does not re-fetch", async () => {
    let calls = 0;
    const failingFetch: typeof fetch = (async () => {
      calls += 1;
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const first = await loadCatalog(fallbackManifest, failingFetch);
    const second = await loadCatalog(fallbackManifest, failingFetch);

    expect(first).toBe(fallbackManifest);
    expect(second).toBe(fallbackManifest);
    expect(calls).toBe(1);
  });
});

describe("mapRawCatalog: reasoning_options", () => {
  test("maps each of the 3 ReasoningOption shapes through toEntry", () => {
    const raw: RawCatalogResponse = {
      groq: {
        models: {
          "effort-model": {
            id: "effort-model",
            name: "Effort Model",
            family: "family",
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
            limit: { context: 1000, output: 100 },
          },
          "toggle-model": {
            id: "toggle-model",
            name: "Toggle Model",
            family: "family",
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: "toggle" }],
            limit: { context: 1000, output: 100 },
          },
          "budget-model": {
            id: "budget-model",
            name: "Budget Model",
            family: "family",
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: "budget_tokens" }],
            limit: { context: 1000, output: 100 },
          },
        },
      },
      openrouter: { models: {} },
      anthropic: { models: {} },
      openai: { models: {} },
      google: { models: {} },
    };

    const entries = mapRawCatalog(raw);

    expect(entries.find((e) => e.id === "effort-model")?.reasoningOptions).toEqual([
      { type: "effort", values: ["low", "medium", "high"] },
    ]);
    expect(entries.find((e) => e.id === "toggle-model")?.reasoningOptions).toEqual([
      { type: "toggle" },
    ]);
    expect(entries.find((e) => e.id === "budget-model")?.reasoningOptions).toEqual([
      { type: "budget_tokens" },
    ]);
  });

  test("a model with multiple reasoning_options entries (GLM-5.2-shaped) keeps all of them", () => {
    const raw: RawCatalogResponse = {
      groq: {
        models: {
          "glm-shaped": {
            id: "glm-shaped",
            name: "GLM Shaped",
            family: "family",
            tool_call: true,
            reasoning: true,
            reasoning_options: [
              { type: "toggle" },
              { type: "effort", values: ["none", "low", "medium", "high"] },
              { type: "budget_tokens" },
            ],
            limit: { context: 1000, output: 100 },
          },
        },
      },
      openrouter: { models: {} },
      anthropic: { models: {} },
      openai: { models: {} },
      google: { models: {} },
    };

    const entries = mapRawCatalog(raw);

    expect(entries.find((e) => e.id === "glm-shaped")?.reasoningOptions).toEqual([
      { type: "toggle" },
      { type: "effort", values: ["none", "low", "medium", "high"] },
      { type: "budget_tokens" },
    ]);
  });

  test("a model with no reasoning_options key does not throw and comes back undefined", () => {
    const entries = mapRawCatalog(rawApiResponse());

    expect(entries.find((e) => e.id === "live-model")?.reasoningOptions).toBeUndefined();
  });
});

describe("findCatalogEntry", () => {
  test("finds an entry by id and provider", () => {
    expect(findCatalogEntry(fallbackManifest, "fallback-model", "groq")).toEqual(
      fallbackManifest.entries[0],
    );
  });

  test("returns undefined for an id/provider combination not present", () => {
    expect(findCatalogEntry(fallbackManifest, "fallback-model", "openrouter")).toBeUndefined();
  });
});

function entryWithPricing(pricing: ModelCatalogEntry["pricing"]): ModelCatalogEntry {
  return { ...(fallbackManifest.entries[0] as ModelCatalogEntry), pricing };
}

// Coverage for the fail-closed contract isZeroPriceEntry's own header comment states: a missing
// entry, or an entry whose pricing is undefined (meaning "unknown", not "free"), must never be
// treated as zero-price — apps/server's Free-tier gate (quota.ts's decidePreflight) trusts this to
// keep unlisted or mixed-priced models off the free tier.
describe("isZeroPriceEntry", () => {
  test("false for an absent entry", () => {
    expect(isZeroPriceEntry(undefined)).toBe(false);
  });

  test("false for an entry whose pricing is undefined", () => {
    expect(isZeroPriceEntry(entryWithPricing(undefined))).toBe(false);
  });

  test("true when both input and output are 0", () => {
    expect(isZeroPriceEntry(entryWithPricing({ inputPerMTok: 0, outputPerMTok: 0 }))).toBe(true);
  });

  test("false when input is priced but output is 0", () => {
    expect(isZeroPriceEntry(entryWithPricing({ inputPerMTok: 1, outputPerMTok: 0 }))).toBe(false);
  });

  test("false when output is priced but input is 0", () => {
    expect(isZeroPriceEntry(entryWithPricing({ inputPerMTok: 0, outputPerMTok: 1 }))).toBe(false);
  });

  test("false when both are priced", () => {
    expect(isZeroPriceEntry(entryWithPricing({ inputPerMTok: 1, outputPerMTok: 2 }))).toBe(false);
  });
});
