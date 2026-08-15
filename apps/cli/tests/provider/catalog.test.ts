import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ModelCatalog, type ModelCatalogEntry, resetCatalogCache } from "@seri/model-catalog";
import { catalogWithFallback, getModelCatalog, resetFallbackWarning } from "../../src/provider/catalog";

function catalogEntry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    displayName: "Llama 3.3 70B",
    family: "llama",
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    toolCall: true,
    reasoning: false,
    pricing: undefined,
    ...overrides,
  };
}

// Scoped to `configured`, not whole-catalog: an unconfigured provider's backfilled rows would
// never be shown (the guided picker filters to the same `configured` set) but would still
// inflate other providers' route-group alternatives counts for no reason.
describe("catalogWithFallback", () => {
  test("backfills a configured provider missing from live", () => {
    const live: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [catalogEntry({ id: "live-groq", provider: "groq" })],
    };

    const result = catalogWithFallback(live, new Set(["groq", "openrouter"]));

    expect(result.entries.some((entry) => entry.id === "live-groq")).toBe(true);
    expect(result.entries.some((entry) => entry.provider === "openrouter")).toBe(true);
  });

  // The scoping regression test: a provider missing from live but not in `configured` must NOT be
  // backfilled — its rows would offer a route the guided picker can't actually honor later.
  test("does not backfill a provider missing from live but not in configured", () => {
    const live: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [catalogEntry({ id: "live-groq", provider: "groq" })],
    };

    const result = catalogWithFallback(live, new Set(["groq"]));

    expect(result.entries.some((entry) => entry.provider === "openrouter")).toBe(false);
  });

  test("live entries win over fallback entries for a provider live already has", () => {
    const live: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [catalogEntry({ id: "live-groq", provider: "groq" })],
    };

    const result = catalogWithFallback(live, new Set(["groq"]));

    expect(result.entries.filter((entry) => entry.provider === "groq")).toEqual([
      live.entries[0],
    ]);
  });
});

// In-process, not a spawned child (M-2/M-3 fix): a spawned child inherits this package's own test
// script env (apps/cli/package.json's `"test": "SERI_DISABLE_MODELS_FETCH=1 bun test"`), which made
// loadCatalog skip the fetch before the injected failing fetch could ever run — so the previous
// version of this test genuinely never exercised the fetch-fails-and-falls-back path it claimed to,
// despite its own comment saying it did. Two things make an in-process test safe here instead:
// `resetCatalogCache()` (packages/model-catalog/src/catalog.ts, now re-exported from index.ts)
// clears the process-lifetime cache another test in this same `bun test` process may have already
// populated, and deleting SERI_DISABLE_MODELS_FETCH for the duration of this test — restored in
// afterEach — makes the outcome independent of whatever the package script sets by default.
describe("getModelCatalog", () => {
  const originalDisableFlag = process.env.SERI_DISABLE_MODELS_FETCH;

  beforeEach(() => {
    resetCatalogCache();
    resetFallbackWarning();
    delete process.env.SERI_DISABLE_MODELS_FETCH;
  });

  afterEach(() => {
    if (originalDisableFlag === undefined) delete process.env.SERI_DISABLE_MODELS_FETCH;
    else process.env.SERI_DISABLE_MODELS_FETCH = originalDisableFlag;
  });

  test("prints a warning exactly once when the live fetch fails, and returns the bundled fallback", async () => {
    // `called` is what actually distinguishes this from the SERI_DISABLE_MODELS_FETCH path: both
    // produce the same externally visible result (one warning, a non-empty fallback catalog) — see
    // this file's own top comment — so the assertion below on `called` is what the previous version
    // of this test was missing and is the reason it did not catch its own vacuousness.
    let called = false;
    const failingFetch: typeof fetch = (async () => {
      called = true;
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    let catalog: Awaited<ReturnType<typeof getModelCatalog>>;
    try {
      catalog = await getModelCatalog(failingFetch);
    } finally {
      console.error = originalError;
    }

    expect(called).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("models.dev");
    expect(catalog.entries.length).toBeGreaterThan(0);
  });

  // Code-review finding, PR #91 round 3: cli.ts's own `run()` and `prepareSession` both call
  // `getModelCatalog()` independently on a guided-setup run. `loadCatalog`'s promise cache dedupes
  // the underlying FETCH across both calls, but each caller used to still do its own
  // `catalog === FALLBACK_MANIFEST` check and print its own warning — one failed fetch, two
  // identical lines. Negative control: pre-fix, `errors` here has length 2.
  test("two independent callers sharing one failed fetch see the warning only once", async () => {
    const failingFetch: typeof fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    try {
      await getModelCatalog(failingFetch);
      await getModelCatalog(failingFetch);
    } finally {
      console.error = originalError;
    }

    expect(errors).toHaveLength(1);
  });
});
