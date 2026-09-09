import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  findCatalogEntry,
  isZeroPriceEntry,
  loadCatalog,
  mapRawCatalog,
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

function validModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "ok-model",
    name: "Ok Model",
    family: "ok",
    tool_call: true,
    reasoning: false,
    limit: { context: 1000, output: 100 },
    ...overrides,
  };
}

function groqRaw(models: Record<string, unknown>) {
  return { groq: { models } };
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

  test("fetch success: maps and filters live entries from the cataloged providers, ignoring other provider keys", async () => {
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

  test("JSON root null: map throws and loadCatalog falls back to the manifest", async () => {
    const catalog = await loadCatalog(fallbackManifest, fakeFetch(null));

    expect(catalog).toBe(fallbackManifest);
  });

  test("JSON root string: map throws and loadCatalog falls back to the manifest", async () => {
    const catalog = await loadCatalog(fallbackManifest, fakeFetch("not-an-object"));

    expect(catalog).toBe(fallbackManifest);
  });

  test("JSON object with no usable models: map throws and loadCatalog falls back to the manifest", async () => {
    const catalog = await loadCatalog(fallbackManifest, fakeFetch({}));

    expect(catalog).toBe(fallbackManifest);
  });
});

describe("mapRawCatalog: parse", () => {
  test("empty object throws", () => {
    expect(() => mapRawCatalog({})).toThrow("catalog JSON had no usable entries");
  });

  test("only tool_call false models throw", () => {
    expect(() =>
      mapRawCatalog(groqRaw({ silent: validModel({ id: "silent", tool_call: false }) })),
    ).toThrow("catalog JSON had no usable entries");
  });

  test("null root throws", () => {
    expect(() => mapRawCatalog(null)).toThrow("catalog JSON root is not a plain object");
  });

  test("array root throws", () => {
    expect(() => mapRawCatalog([])).toThrow("catalog JSON root is not a plain object");
  });

  test("primitive root throws", () => {
    expect(() => mapRawCatalog("not-an-object")).toThrow("catalog JSON root is not a plain object");
    expect(() => mapRawCatalog(1)).toThrow("catalog JSON root is not a plain object");
  });

  test("unknown provider keys are ignored", () => {
    const entries = mapRawCatalog({
      groq: { models: { "ok-model": validModel() } },
      "other-provider": { models: { "ignored-model": validModel({ id: "ignored-model" }) } },
    });

    expect(entries.map((e) => e.id)).toEqual(["ok-model"]);
  });

  test("provider value without a models object is skipped", () => {
    const entries = mapRawCatalog({
      groq: { not_models: { "ok-model": validModel() } },
      anthropic: { models: { "claude-ok": validModel({ id: "claude-ok", name: "Claude Ok" }) } },
    });

    expect(entries.map((e) => e.id)).toEqual(["claude-ok"]);
  });

  test("skips a model whose id is not a non-empty string", () => {
    const entries = mapRawCatalog(
      groqRaw({
        empty: validModel({ id: "" }),
        numbered: validModel({ id: 1 }),
        good: validModel({ id: "good", name: "Good" }),
      }),
    );

    expect(entries.map((e) => e.id)).toEqual(["good"]);
  });

  test("skips a model whose name is not a non-empty string", () => {
    const entries = mapRawCatalog(
      groqRaw({
        empty: validModel({ name: "" }),
        good: validModel({ id: "good", name: "Good" }),
      }),
    );

    expect(entries.map((e) => e.id)).toEqual(["good"]);
  });

  test("skips a model whose tool_call is not boolean", () => {
    const entries = mapRawCatalog(
      groqRaw({
        bad: validModel({ id: "bad", tool_call: "yes" }),
        good: validModel({ id: "good", name: "Good" }),
      }),
    );

    expect(entries.map((e) => e.id)).toEqual(["good"]);
  });

  test("non-boolean reasoning is stored as false and the model is kept", () => {
    const entries = mapRawCatalog(
      groqRaw({
        flagged: validModel({ id: "flagged", reasoning: "yes" }),
        missing: validModel({ id: "missing", reasoning: undefined }),
      }),
    );

    expect(entries.map((e) => e.id)).toEqual(["flagged", "missing"]);
    expect(entries.every((e) => e.reasoning === false)).toBe(true);
  });

  test("skips a model whose limit.context or limit.output is not a number", () => {
    const entries = mapRawCatalog(
      groqRaw({
        badContext: validModel({ id: "bad-context", limit: { context: "1000", output: 100 } }),
        badOutput: validModel({ id: "bad-output", limit: { context: 1000, output: null } }),
        nan: validModel({ id: "nan", limit: { context: Number.NaN, output: 100 } }),
        good: validModel({ id: "good", name: "Good" }),
      }),
    );

    expect(entries.map((e) => e.id)).toEqual(["good"]);
  });

  test("family that is not a string is stored as null", () => {
    const entries = mapRawCatalog(
      groqRaw({
        numbered: validModel({ id: "numbered", family: 1 }),
        missing: validModel({ id: "missing", family: undefined }),
      }),
    );

    expect(entries.find((e) => e.id === "numbered")?.family).toBeNull();
    expect(entries.find((e) => e.id === "missing")?.family).toBeNull();
  });

  test("invalid cost omits pricing and keeps the model", () => {
    const entries = mapRawCatalog(
      groqRaw({
        stringInput: validModel({ id: "string-input", cost: { input: "1", output: 2 } }),
        missingOutput: validModel({ id: "missing-output", cost: { input: 1 } }),
      }),
    );

    expect(entries.map((e) => e.id)).toEqual(["string-input", "missing-output"]);
    expect(entries.every((e) => e.pricing === undefined)).toBe(true);
  });

  test("unusable optional cache fields omit cache pricing and keep input and output", () => {
    const entries = mapRawCatalog(
      groqRaw({
        badCache: validModel({
          id: "bad-cache",
          cost: { input: 1, output: 2, cache_read: "nope", cache_write: null },
        }),
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.pricing).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
  });

  test("valid cost keeps numeric input/output and optional cache fields", () => {
    const entries = mapRawCatalog(
      groqRaw({
        priced: validModel({
          id: "priced",
          cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
        }),
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.pricing).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 0.2,
    });
  });

  test("reasoning_options that is not an array is omitted", () => {
    const entries = mapRawCatalog(
      groqRaw({
        obj: validModel({
          id: "obj",
          reasoning_options: { type: "effort", values: ["low"] },
        }),
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.reasoningOptions).toBeUndefined();
  });

  test("null and unknown option elements are dropped; remaining valid options are kept", () => {
    const entries = mapRawCatalog(
      groqRaw({
        mixed: validModel({
          id: "mixed",
          reasoning: true,
          reasoning_options: [
            null,
            { type: "mystery" },
            { type: "effort", values: ["low", "medium"] },
          ],
        }),
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.reasoningOptions).toEqual([{ type: "effort", values: ["low", "medium"] }]);
  });

  test("effort without a string[] values is dropped; other valid options stay", () => {
    const entries = mapRawCatalog(
      groqRaw({
        mixed: validModel({
          id: "mixed",
          reasoning: true,
          reasoning_options: [
            { type: "effort" },
            { type: "effort", values: {} },
            { type: "effort", values: [] },
            { type: "effort", values: [""] },
            { type: "effort", values: ["low", 1] },
            { type: "toggle" },
          ],
        }),
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.reasoningOptions).toEqual([{ type: "toggle" }]);
  });

  test("if every option is dropped, reasoningOptions is omitted", () => {
    const entries = mapRawCatalog(
      groqRaw({
        empty: validModel({
          id: "empty",
          reasoning: true,
          reasoning_options: [null, { type: "effort" }],
        }),
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.reasoningOptions).toBeUndefined();
  });

  test("a well-formed sibling next to a malformed model still appears; the malformed one does not", () => {
    const entries = mapRawCatalog(
      groqRaw({
        bad: validModel({ id: "", name: "Bad" }),
        good: validModel({ id: "good", name: "Good" }),
      }),
    );

    expect(entries.map((e) => e.id)).toEqual(["good"]);
    expect(entries[0]?.displayName).toBe("Good");
  });
});

describe("mapRawCatalog: reasoning_options", () => {
  test("maps each of the 3 ReasoningOption shapes", () => {
    const raw = {
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
    const raw = {
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
