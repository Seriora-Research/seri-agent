import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelCatalogEntry } from "@seri/model-catalog";
import { getModel } from "../../src/provider/model";
import { resolveRoute } from "../../src/provider/routing";

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

// D1's own motivating example, reused here as the fixture: claude-sonnet-5 reachable natively via
// Anthropic and via OpenRouter, plus one entry with no siblings at all (no other provider carries
// its route key).
const catalog: ModelCatalog = {
  fetchedAt: "2026-08-11T00:00:00.000Z",
  entries: [
    entry({ id: "claude-sonnet-5", provider: "anthropic" }),
    entry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" }),
    entry({ id: "solo-model", provider: "groq" }),
  ],
};

const ALL_KEY_NAMES = [
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
];
const originalEnv = Object.fromEntries(ALL_KEY_NAMES.map((name) => [name, process.env[name]]));

function restoreEnv(): void {
  for (const name of ALL_KEY_NAMES) {
    const original = originalEnv[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

let tmpRoot: string;

beforeEach(() => {
  for (const name of ALL_KEY_NAMES) delete process.env[name];
  // Points the config dir at an empty temp dir so a real config.json on this machine can never
  // supply a key and mask the "nothing configured" case — same pattern anthropic.test.ts etc. use.
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-routing-test-"));
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  restoreEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveRoute", () => {
  test("an exact pair with a key stays exactly as requested", () => {
    const route = resolveRoute(
      catalog,
      { model: "anthropic/claude-sonnet-5", provider: "openrouter" },
      new Set(["openrouter"]),
    );
    expect(route).toEqual({
      model: "anthropic/claude-sonnet-5",
      provider: "openrouter",
      rerouted: false,
    });
  });

  test("reroutes to a native sibling when the requested provider has no key and the sibling does", () => {
    const route = resolveRoute(
      catalog,
      { model: "anthropic/claude-sonnet-5", provider: "openrouter" },
      new Set(["anthropic"]),
    );
    expect(route.model).toBe("claude-sonnet-5");
    expect(route.provider).toBe("anthropic");
    expect(route.rerouted).toBe(true);
    expect(route.reason).toBe("OPENROUTER_API_KEY");
  });

  test("an explicit pick wins over a native sibling even when both have a key", () => {
    const route = resolveRoute(
      catalog,
      { model: "anthropic/claude-sonnet-5", provider: "openrouter" },
      new Set(["anthropic", "openrouter"]),
    );
    expect(route).toEqual({
      model: "anthropic/claude-sonnet-5",
      provider: "openrouter",
      rerouted: false,
    });
  });

  test("an explicit native pick stays native when both have a key", () => {
    const route = resolveRoute(
      catalog,
      { model: "claude-sonnet-5", provider: "anthropic" },
      new Set(["anthropic", "openrouter"]),
    );
    expect(route).toEqual({ model: "claude-sonnet-5", provider: "anthropic", rerouted: false });
  });

  test("nothing configured leaves the pair unchanged, and getModel on it still throws the legacy message", () => {
    const route = resolveRoute(
      catalog,
      { model: "anthropic/claude-sonnet-5", provider: "openrouter" },
      new Set(),
    );
    expect(route).toEqual({
      model: "anthropic/claude-sonnet-5",
      provider: "openrouter",
      rerouted: false,
    });
    expect(() => getModel(route.model, route.provider, "test-session-id")).toThrow(
      "OPENROUTER_API_KEY is not set. Run: seri config set OPENROUTER_API_KEY <your-key>",
    );
  });

  test("a model with no siblings is left unchanged even with other providers configured", () => {
    const route = resolveRoute(
      catalog,
      { model: "solo-model", provider: "groq" },
      new Set(["anthropic", "openrouter", "openai", "google"]),
    );
    expect(route).toEqual({ model: "solo-model", provider: "groq", rerouted: false });
  });

  test("an id absent from the catalog is left unchanged and never throws", () => {
    const route = resolveRoute(
      catalog,
      { model: "not-in-the-catalog", provider: "groq" },
      new Set(["anthropic", "openrouter"]),
    );
    expect(route).toEqual({ model: "not-in-the-catalog", provider: "groq", rerouted: false });
  });
});
