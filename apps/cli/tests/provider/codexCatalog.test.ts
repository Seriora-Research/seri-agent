import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog } from "@seri/model-catalog";
import {
  isCodexPlanCatalogApplied,
  overlayCodexModels,
  resetCodexPlanCatalogApplied,
  withCodexSubscriptionCatalog,
} from "../../src/provider/catalog";

const catalog: ModelCatalog = {
  fetchedAt: "2026-09-01T00:00:00.000Z",
  entries: [
    {
      id: "gpt-4.1",
      provider: "openai",
      displayName: "GPT-4.1",
      family: "gpt",
      contextWindow: 1_047_576,
      maxOutputTokens: 32_768,
      toolCall: true,
      reasoning: false,
      pricing: { inputPerMTok: 2, outputPerMTok: 8 },
    },
    {
      id: "llama-3.3-70b-versatile",
      provider: "groq",
      displayName: "Llama",
      family: "llama",
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
      toolCall: true,
      reasoning: false,
      pricing: undefined,
    },
  ],
};

describe("overlayCodexModels", () => {
  test("replaces openai rows with the plan-scoped list and drops dollar pricing", () => {
    const overlaid = overlayCodexModels(catalog, [
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        supportedReasoningEfforts: ["low", "high"],
      },
    ]);
    const openai = overlaid.entries.filter((entry) => entry.provider === "openai");
    expect(openai.map((entry) => entry.id)).toEqual(["gpt-5.6-terra"]);
    expect(openai[0]?.pricing).toBeUndefined();
    expect(openai[0]?.reasoningOptions).toEqual([{ type: "effort", values: ["low", "high"] }]);
    expect(overlaid.entries.some((entry) => entry.provider === "groq")).toBe(true);
  });

  test("an empty list leaves the catalog unchanged", () => {
    expect(overlayCodexModels(catalog, [])).toBe(catalog);
  });
});

describe("withCodexSubscriptionCatalog", () => {
  const originalHome = process.env.CODEX_HOME;
  let home: string;

  afterEach(() => {
    resetCodexPlanCatalogApplied();
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  });

  test("without a chatgpt login it leaves the catalog and does not apply overlay", async () => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-catalog-"));
    process.env.CODEX_HOME = home;
    const warnings: string[] = [];
    const result = await withCodexSubscriptionCatalog(
      catalog,
      (line) => warnings.push(line),
      async () => {
        throw new Error("should not list");
      },
    );
    expect(result).toBe(catalog);
    expect(isCodexPlanCatalogApplied()).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("a successful list overlays openai rows and marks the plan catalog applied", async () => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-catalog-"));
    process.env.CODEX_HOME = home;
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok", account_id: "acct" },
      }),
    );
    const overlaid = await withCodexSubscriptionCatalog(catalog, undefined, async () => [
      { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", supportedReasoningEfforts: [] },
    ]);
    expect(overlaid.entries.filter((e) => e.provider === "openai").map((e) => e.id)).toEqual([
      "gpt-5.6-terra",
    ]);
    expect(isCodexPlanCatalogApplied()).toBe(true);
  });

  test("a list throw warns and does not mark the API catalog as plan-applied", async () => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-catalog-"));
    process.env.CODEX_HOME = home;
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok", account_id: "acct" },
      }),
    );
    const warnings: string[] = [];
    const result = await withCodexSubscriptionCatalog(
      catalog,
      (line) => warnings.push(line),
      async () => {
        throw new Error("app-server down");
      },
    );
    expect(result).toBe(catalog);
    expect(isCodexPlanCatalogApplied()).toBe(false);
    expect(warnings.some((line) => line.includes("plan model list"))).toBe(true);
  });
});
