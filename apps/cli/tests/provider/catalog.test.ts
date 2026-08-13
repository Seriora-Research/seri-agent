import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetCatalogCache } from "@seri/model-catalog";
import { getModelCatalog, resetFallbackWarning } from "../../src/provider/catalog";

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
