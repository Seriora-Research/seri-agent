import { describe, expect, test } from "bun:test";
import { groupRoutes, routeKey, routesFor } from "../src/routes";
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

describe("routeKey", () => {
  test("strips a vendor prefix and lowercases the slug", () => {
    expect(routeKey(entry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" }))).toBe(
      "anthropic/claude-sonnet-5",
    );
  });

  test("strips a leading ~ (OpenRouter's auto-alias prefix)", () => {
    expect(routeKey(entry({ id: "~google/gemini-flash-latest", provider: "openrouter" }))).toBe(
      "google/gemini-flash-latest",
    );
  });



  test("maps . and _ separators to - in the slug, but not the vendor", () => {
    expect(routeKey(entry({ id: "anthropic/claude-sonnet-4.5", provider: "openrouter" }))).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(routeKey(entry({ id: "foo_bar/baz.qux", provider: "openrouter" }))).toBe(
      "foo_bar/baz-qux",
    );
  });



  test("a native id with no slash uses the entry's own provider as vendor", () => {
    expect(routeKey(entry({ id: "claude-sonnet-5", provider: "anthropic" }))).toBe(
      "anthropic/claude-sonnet-5",
    );
  });
});

describe("groupRoutes", () => {


  test("groups a native entry with its OpenRouter counterpart", () => {
    const entries = [
      entry({ id: "claude-sonnet-5", provider: "anthropic" }),
      entry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" }),
    ];
    const groups = groupRoutes(entries);
    expect(groups.size).toBe(1);
    expect(groups.get("anthropic/claude-sonnet-5")).toEqual(entries);
  });


  test("groups entries whose ids differ only by separator style", () => {
    const entries = [
      entry({ id: "claude-sonnet-4-5", provider: "anthropic" }),
      entry({ id: "anthropic/claude-sonnet-4.5", provider: "openrouter" }),
    ];
    expect(groupRoutes(entries).size).toBe(1);
  });



  test("groups a groq entry with its OpenRouter counterpart", () => {
    const entries = [
      entry({ id: "openai/gpt-oss-120b", provider: "groq" }),
      entry({ id: "openai/gpt-oss-120b", provider: "openrouter" }),
    ];
    expect(groupRoutes(entries).size).toBe(1);
  });





  test("does not group two genuinely different models", () => {
    const entries = [
      entry({ id: "foo", provider: "openai" }),
      entry({ id: "mistralai/foo", provider: "openrouter" }),
    ];
    const groups = groupRoutes(entries);
    expect(groups.size).toBe(2);
  });

  test("preserves first-appearance order of groups and of entries within a group", () => {
    const entries = [
      entry({ id: "b", provider: "groq" }),
      entry({ id: "a", provider: "groq" }),


      entry({ id: "groq/b", provider: "openrouter" }),
    ];
    const groups = groupRoutes(entries);
    expect([...groups.keys()]).toEqual(["groq/b", "groq/a"]);
    expect(groups.get("groq/b")?.map((e) => e.provider)).toEqual(["groq", "openrouter"]);
  });
});

describe("routesFor", () => {
  test("returns every entry sharing the given entry's route key, itself included", () => {
    const native = entry({ id: "claude-sonnet-5", provider: "anthropic" });
    const viaOpenRouter = entry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" });
    const unrelated = entry({ id: "gpt-4.1-mini", provider: "openai" });

    expect(routesFor([native, viaOpenRouter, unrelated], native)).toEqual([native, viaOpenRouter]);
  });
});

describe("routeKey vendor aliases", () => {
  test("a native xai id groups with the same model behind OpenRouter's x-ai prefix", () => {
    const native = routeKey(entry({ id: "grok-4.5", provider: "xai" }));
    const aggregated = routeKey(entry({ id: "x-ai/grok-4.5", provider: "openrouter" }));
    expect(native).toBe(aggregated);
  });

  test("the alias also applies through OpenRouter's ~ auto-alias prefix", () => {
    expect(routeKey(entry({ id: "~x-ai/grok-latest", provider: "openrouter" }))).toBe(
      routeKey(entry({ id: "grok-latest", provider: "xai" })),
    );
  });

  test("aliasing the vendor does not merge two different grok slugs", () => {
    expect(routeKey(entry({ id: "grok-4.5", provider: "xai" }))).not.toBe(
      routeKey(entry({ id: "x-ai/grok-4.3", provider: "openrouter" })),
    );
  });

  test("an unaliased vendor is untouched", () => {
    expect(routeKey(entry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" }))).toBe(
      "anthropic/claude-sonnet-5",
    );
  });
});
