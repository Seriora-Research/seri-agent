import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelCatalog, type ModelCatalogEntry, resetCatalogCache } from "@seri/model-catalog";
import { resetCodexModelCache } from "../../src/auth/codexRefresh";
import {
  catalogForModelPicker,
  catalogWithFallback,
  getModelCatalog,
  idsFromGrokModelsPayload,
  isCodexPlanCatalogApplied,
  mergeGrokSubscriptionCatalog,
  resetCodexPlanCatalogApplied,
  resetFallbackWarning,
  withCodexSubscriptionCatalog,
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

  test("catalogForModelPicker overlays plan ids after a mid-session ChatGPT connect", async () => {
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const configDir = mkdtempSync(join(tmpdir(), "seri-catalog-picker-refresh-"));
    resetCodexModelCache();
    resetCodexPlanCatalogApplied();
    const apiCatalog: ModelCatalog = {
      fetchedAt: "2026-09-03T00:00:00.000Z",
      entries: [
        catalogEntry({
          id: "gpt-4.1",
          provider: "openai",
          displayName: "GPT-4.1",
          family: "gpt",
          pricing: { inputPerMTok: 2, outputPerMTok: 8 },
        }),
      ],
    };
    try {
      expect(isCodexPlanCatalogApplied()).toBe(false);
      writeFileSync(
        join(configDir, "codex-auth.json"),
        JSON.stringify({
          accessToken: "tok-plan",
          refreshToken: "refresh-plan",
          obtainedAt: new Date().toISOString(),
          accountId: "acct-plan",
        }),
      );
      const refreshed = await catalogForModelPicker(apiCatalog, configDir, (async (
        input: RequestInfo | URL,
      ) => {
        const url = String(input);
        if (url.includes("/backend-api/codex/models")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  slug: "gpt-5.4-mini",
                  display_name: "GPT-5.4 mini",
                  visibility: "list",
                  supported_in_api: true,
                },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as unknown as typeof fetch);
      expect(isCodexPlanCatalogApplied()).toBe(true);
      expect(
        refreshed.entries.some(
          (entry) => entry.provider === "openai" && entry.id === "gpt-5.4-mini",
        ),
      ).toBe(true);
      expect(refreshed.entries.some((entry) => entry.id === "gpt-4.1")).toBe(false);
    } finally {
      resetCodexModelCache();
      resetCodexPlanCatalogApplied();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("catalogForModelPicker is a no-op without a grant and after overlay", async () => {
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const configDir = mkdtempSync(join(tmpdir(), "seri-catalog-picker-noop-"));
    const leftover = mkdtempSync(join(tmpdir(), "seri-catalog-picker-noop-home-"));
    const originalHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = leftover;
    resetCodexModelCache();
    resetCodexPlanCatalogApplied();
    const current: ModelCatalog = {
      fetchedAt: "2026-09-03T00:00:00.000Z",
      entries: [catalogEntry({ id: "gpt-4.1", provider: "openai" })],
    };
    const boom = (async () => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    try {
      expect(await catalogForModelPicker(current, configDir, boom)).toBe(current);
      writeFileSync(
        join(configDir, "codex-auth.json"),
        JSON.stringify({
          accessToken: "tok-plan",
          refreshToken: "refresh-plan",
          obtainedAt: new Date().toISOString(),
          accountId: "acct-plan",
        }),
      );
      await withCodexSubscriptionCatalog(
        current,
        undefined,
        async () => [
          { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini", supportedReasoningEfforts: [] },
        ],
        configDir,
      );
      expect(isCodexPlanCatalogApplied()).toBe(true);
      expect(await catalogForModelPicker(current, configDir, boom)).toBe(current);
    } finally {
      resetCodexModelCache();
      resetCodexPlanCatalogApplied();
      if (originalHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalHome;
      rmSync(configDir, { recursive: true, force: true });
      rmSync(leftover, { recursive: true, force: true });
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
