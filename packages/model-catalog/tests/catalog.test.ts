import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { findCatalogEntry, loadCatalog, resetCatalogCache } from "../src/catalog";
import type { ModelCatalog } from "../src/types";

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

  // apps/server's own EMPTY_MANIFEST fallback would otherwise fail isZeroPriceModel for every
  // Free-tier request for the rest of the process's life after one transient models.dev failure
  // — a fallback result must not be cached the way a genuine fetched catalog is.
  test("fetch failure: does not permanently cache the fallback — a later call retries", async () => {
    let calls = 0;
    const failingFetch: typeof fetch = (async () => {
      calls += 1;
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const first = await loadCatalog(fallbackManifest, failingFetch);
    const second = await loadCatalog(fallbackManifest, failingFetch);

    expect(first).toBe(fallbackManifest);
    expect(second).toBe(fallbackManifest);
    expect(calls).toBe(2);
  });

  test("fetch failure then success: the call after a failed fetch can still succeed", async () => {
    let calls = 0;
    const fetchFn: typeof fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return { ok: true, status: 200, json: async () => rawApiResponse() } as unknown as Response;
    }) as unknown as typeof fetch;

    const first = await loadCatalog(fallbackManifest, fetchFn);
    const second = await loadCatalog(fallbackManifest, fetchFn);

    expect(first).toBe(fallbackManifest);
    expect(second).not.toBe(fallbackManifest);
    expect(second.entries.length).toBeGreaterThan(0);
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
