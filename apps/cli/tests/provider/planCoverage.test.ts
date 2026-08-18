import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntry } from "@seri/model-catalog";
import { planCoverage } from "../../src/provider/planCoverage";

function entry(pricing: ModelCatalogEntry["pricing"]): ModelCatalogEntry {
  return {
    id: "m",
    provider: "openrouter",
    displayName: "M",
    family: null,
    contextWindow: 1,
    maxOutputTokens: 1,
    toolCall: false,
    reasoning: false,
    pricing,
  };
}

const zeroPriced = entry({ inputPerMTok: 0, outputPerMTok: 0 });
const priced = entry({ inputPerMTok: 1, outputPerMTok: 1 });
const unknownPricing = entry(undefined);

describe("planCoverage", () => {
  test("a paid plan covers any priced entry", () => {
    expect(planCoverage(priced, "pro")).toBe(true);
  });

  test("free covers a zero-priced entry", () => {
    expect(planCoverage(zeroPriced, "free")).toBe(true);
  });

  test("free does not cover a priced entry", () => {
    expect(planCoverage(priced, "free")).toBe(false);
  });

  test("free does not cover an entry with unknown pricing", () => {
    expect(planCoverage(unknownPricing, "free")).toBe(false);
  });

  test("a null plan covers nothing, regardless of the entry", () => {
    expect(planCoverage(zeroPriced, null)).toBe(false);
    expect(planCoverage(priced, null)).toBe(false);
  });
});
