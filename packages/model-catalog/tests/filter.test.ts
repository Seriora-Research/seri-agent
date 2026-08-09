import { describe, expect, test } from "bun:test";
import { filterCatalogEntries } from "../src/filter";
import type { ModelCatalogEntry } from "../src/types";

function entry(overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return {
    id: "some-model",
    provider: "groq",
    displayName: "Some Model",
    family: "some",
    contextWindow: 1000,
    maxOutputTokens: 100,
    toolCall: true,
    reasoning: false,
    pricing: undefined,
    ...overrides,
  };
}

describe("filterCatalogEntries", () => {
  test("keeps only entries with toolCall true", () => {
    const entries = [
      entry({ id: "a", toolCall: true }),
      entry({ id: "b", toolCall: false }),
      entry({ id: "c", toolCall: true }),
    ];

    expect(filterCatalogEntries(entries).map((e) => e.id)).toEqual(["a", "c"]);
  });
});
