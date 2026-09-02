import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelCatalog, type ModelCatalogEntry, resetCatalogCache } from "@seri/model-catalog";
import { resetCodexModelCache } from "../../src/auth/codexRefresh";
import {
  catalogWithFallback,
  getModelCatalog,
  idsFromGrokModelsPayload,
  isCodexPlanCatalogApplied,
  mergeGrokSubscriptionCatalog,
  resetCodexPlanCatalogApplied,
  resetFallbackWarning,
} from "../../src/provider/catalog";

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

    expect(result.entries.filter((entry) => entry.provider === "groq")).toEqual([live.entries[0]]);
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
  const originalCodexHome = process.env.CODEX_HOME;
  let isolatedCodexHome: string;

  beforeEach(() => {
    resetCatalogCache();
    resetFallbackWarning();
    delete process.env.SERI_DISABLE_MODELS_FETCH;
    isolatedCodexHome = mkdtempSync(join(tmpdir(), "seri-catalog-codex-"));
    process.env.CODEX_HOME = isolatedCodexHome;
  });

  afterEach(() => {
    if (originalDisableFlag === undefined) delete process.env.SERI_DISABLE_MODELS_FETCH;
    else process.env.SERI_DISABLE_MODELS_FETCH = originalDisableFlag;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(isolatedCodexHome, { recursive: true, force: true });
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

  // Both paths return the bundled manifest, so a single warning worded for a failed fetch told a
  // user running with the flag that something was unreachable when nothing had been tried. `fetch` is not stubbed here on purpose: reaching it at all would fail
  // the `called` assertion this test makes.
  test("the SERI_DISABLE_MODELS_FETCH path says the fetch was disabled, not that models.dev was unreachable", async () => {
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    let called = false;
    const spyFetch: typeof fetch = (async () => {
      called = true;
      throw new Error("should never run");
    }) as unknown as typeof fetch;

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    let catalog: Awaited<ReturnType<typeof getModelCatalog>>;
    try {
      catalog = await getModelCatalog(spyFetch);
    } finally {
      console.error = originalError;
    }

    expect(called).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("SERI_DISABLE_MODELS_FETCH");
    expect(errors[0]).not.toContain("could not reach");
    expect(catalog.entries.length).toBeGreaterThan(0);
  });

  test("overlays ChatGPT plan models from HTTP with no Codex CLI", async () => {
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const configDir = mkdtempSync(join(tmpdir(), "seri-catalog-codex-http-"));
    writeFileSync(
      join(configDir, "codex-auth.json"),
      JSON.stringify({
        accessToken: "tok-plan",
        refreshToken: "refresh-plan",
        obtainedAt: new Date().toISOString(),
        accountId: "acct-plan",
      }),
    );
    resetCodexModelCache();
    resetCodexPlanCatalogApplied();
    try {
      const catalog = await getModelCatalog(
        (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/backend-api/codex/models")) {
            return new Response(
              JSON.stringify({
                data: [{ id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" }],
              }),
              { status: 200 },
            );
          }
          throw new Error(`unexpected fetch ${url}`);
        }) as typeof fetch,
        undefined,
        configDir,
      );
      expect(isCodexPlanCatalogApplied()).toBe(true);
      expect(
        catalog.entries.some((entry) => entry.provider === "openai" && entry.id === "gpt-5.6-luna"),
      ).toBe(true);
    } finally {
      resetCodexModelCache();
      resetCodexPlanCatalogApplied();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("idsFromGrokModelsPayload", () => {
  test("reads ids from { data: [{ id }] } and from a string list", () => {
    expect(idsFromGrokModelsPayload({ data: [{ id: "grok-4" }, { id: "grok-3" }] })).toEqual([
      "grok-4",
      "grok-3",
    ]);
    expect(idsFromGrokModelsPayload(["grok-4", ""])).toEqual(["grok-4"]);
  });

  test("returns [] for an unusable payload", () => {
    expect(idsFromGrokModelsPayload(null)).toEqual([]);
    expect(idsFromGrokModelsPayload({})).toEqual([]);
  });
});

describe("mergeGrokSubscriptionCatalog", () => {
  test("an empty id list leaves the catalog untouched", () => {
    const catalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [catalogEntry({ id: "grok-4", provider: "xai" })],
    };
    expect(mergeGrokSubscriptionCatalog(catalog, [])).toBe(catalog);
  });

  test("keeps models.dev metadata for known ids and stubs unknown ones", () => {
    const known = catalogEntry({
      id: "grok-4",
      provider: "xai",
      displayName: "Grok 4",
      contextWindow: 256_000,
    });
    const other = catalogEntry({ id: "llama", provider: "groq" });
    const catalog: ModelCatalog = {
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entries: [known, other],
    };
    const merged = mergeGrokSubscriptionCatalog(catalog, ["grok-4", "grok-new"]);
    const xai = merged.entries.filter((entry) => entry.provider === "xai");
    expect(xai.map((entry) => entry.id)).toEqual(["grok-4", "grok-new"]);
    expect(xai[0]).toBe(known);
    expect(xai[1]?.displayName).toBe("grok-new");
    expect(merged.entries.some((entry) => entry.provider === "groq")).toBe(true);
  });
});
