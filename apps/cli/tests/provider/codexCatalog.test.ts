import { describe, expect, test } from "bun:test";
import type { ModelCatalog } from "@seri/model-catalog";
import { overlayCodexModels } from "../../src/provider/catalog";

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
