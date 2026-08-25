import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelCatalogEntry } from "@seri/model-catalog";
import { getModel } from "../../src/provider/model";
import {
  resolveLegalReasoningTiers,
  resolveRoute,
  resolveSessionRoute,
} from "../../src/provider/routing";

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
    // A groq-native model WITH an OpenRouter-catalog sibling — Rule 4's own fixture, distinct from
    // solo-model (which has none) so the two can't be confused.
    entry({ id: "shared-model", provider: "groq" }),
    entry({ id: "groq/shared-model", provider: "openrouter" }),
  ],
};

// Provider API keys, plus SERI_MODEL/SERI_PROVIDER: the "a session with no model/provider at all"
// tests below set the latter two directly and used to delete them at their own end, which a thrown
// assertion mid-test skips — leaking them into whichever test in this file runs next. One shared
// clear/capture/restore list, matching every other env var this file already guards this way,
// closes that regardless of where in a test a failure happens.
const ALL_KEY_NAMES = [
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "SERI_MODEL",
  "SERI_PROVIDER",
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
      viaGateway: false,
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
      viaGateway: false,
    });
  });

  test("an explicit native pick stays native when both have a key", () => {
    const route = resolveRoute(
      catalog,
      { model: "claude-sonnet-5", provider: "anthropic" },
      new Set(["anthropic", "openrouter"]),
    );
    expect(route).toEqual({
      model: "claude-sonnet-5",
      provider: "anthropic",
      rerouted: false,
      viaGateway: false,
    });
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
      viaGateway: false,
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
    expect(route).toEqual({
      model: "solo-model",
      provider: "groq",
      rerouted: false,
      viaGateway: false,
    });
  });

  test("an id absent from the catalog is left unchanged and never throws", () => {
    const route = resolveRoute(
      catalog,
      { model: "not-in-the-catalog", provider: "groq" },
      new Set(["anthropic", "openrouter"]),
    );
    expect(route).toEqual({
      model: "not-in-the-catalog",
      provider: "groq",
      rerouted: false,
      viaGateway: false,
    });
  });

  describe("Rule 4: route via gateway", () => {
    test("no key anywhere, an OpenRouter sibling exists, and the plan covers it: viaGateway true, routed to the OpenRouter entry", () => {
      const route = resolveRoute(
        catalog,
        { model: "shared-model", provider: "groq" },
        new Set(),
        "pro",
      );
      expect(route).toEqual({
        model: "groq/shared-model",
        provider: "openrouter",
        rerouted: false,
        viaGateway: true,
      });
    });

    test("no key anywhere and plan: null leaves viaGateway false, unchanged from today", () => {
      const route = resolveRoute(catalog, { model: "shared-model", provider: "groq" }, new Set());
      expect(route.viaGateway).toBe(false);
    });

    // A provider-exclusive model (no OpenRouter-catalog sibling at all) never shows viaGateway,
    // even under a covering plan — correct, not a regression: the gateway only ever forwards to
    // GATEWAY_PROVIDER, so it structurally cannot serve a model that provider doesn't list.
    test("a model with no OpenRouter sibling is never gateway-covered, even under a paid plan", () => {
      const route = resolveRoute(
        catalog,
        { model: "solo-model", provider: "groq" },
        new Set(),
        "pro",
      );
      expect(route).toEqual({
        model: "solo-model",
        provider: "groq",
        rerouted: false,
        viaGateway: false,
      });
    });

    // Coverage is evaluated against GATEWAY_PROVIDER's own listing, not the requested provider's —
    // this is the exact mismatch a naive "check whatever entry was requested" implementation gets
    // wrong. The groq entry here is zero-priced; the OpenRouter sibling is not — a check against
    // the wrong entry would wrongly cover this under Free.
    test("free: coverage checks the OpenRouter sibling's price, not the requested (groq) entry's price", () => {
      const mismatchCatalog: ModelCatalog = {
        fetchedAt: "2026-08-11T00:00:00.000Z",
        entries: [
          entry({
            id: "mismatch-model",
            provider: "groq",
            pricing: { inputPerMTok: 0, outputPerMTok: 0 },
          }),
          entry({
            id: "groq/mismatch-model",
            provider: "openrouter",
            pricing: { inputPerMTok: 1, outputPerMTok: 1 },
          }),
        ],
      };
      const route = resolveRoute(
        mismatchCatalog,
        { model: "mismatch-model", provider: "groq" },
        new Set(),
        "free",
      );
      expect(route.viaGateway).toBe(false);
    });

    // The inverse of the mismatch test above: the requested (groq) entry is priced, but the
    // OpenRouter sibling — the one actually checked — is zero-priced, so Free DOES cover it, and
    // the returned route points at the OpenRouter entry.
    test("free: covers via the OpenRouter sibling's zero price even when the requested entry is priced", () => {
      const mismatchCatalog: ModelCatalog = {
        fetchedAt: "2026-08-11T00:00:00.000Z",
        entries: [
          entry({
            id: "mismatch-model-2",
            provider: "groq",
            pricing: { inputPerMTok: 1, outputPerMTok: 1 },
          }),
          entry({
            id: "groq/mismatch-model-2",
            provider: "openrouter",
            pricing: { inputPerMTok: 0, outputPerMTok: 0 },
          }),
        ],
      };
      const route = resolveRoute(
        mismatchCatalog,
        { model: "mismatch-model-2", provider: "groq" },
        new Set(),
        "free",
      );
      expect(route).toEqual({
        model: "groq/mismatch-model-2",
        provider: "openrouter",
        rerouted: false,
        viaGateway: true,
      });
    });

    // Regression: Rule 1 (own-key-wins) is unaffected by a non-null covering plan — an explicit
    // pick whose own provider has a key still returns unchanged even when `plan` would otherwise
    // cover it.
    test("regression: Rule 1 wins over a covering plan when the requested provider has its own key", () => {
      const route = resolveRoute(
        catalog,
        { model: "solo-model", provider: "groq" },
        new Set(["groq"]),
        "pro",
      );
      expect(route).toEqual({
        model: "solo-model",
        provider: "groq",
        rerouted: false,
        viaGateway: false,
      });
    });

    // Regression: a configured sibling still wins over gateway coverage — when both a sibling key
    // AND planCoverage are available, the reroute-to-sibling outcome is returned, never
    // viaGateway: true.
    test("regression: a configured sibling wins over gateway coverage", () => {
      const route = resolveRoute(
        catalog,
        { model: "anthropic/claude-sonnet-5", provider: "openrouter" },
        new Set(["anthropic"]),
        "pro",
      );
      expect(route.rerouted).toBe(true);
      expect(route.viaGateway).toBe(false);
    });
  });
});

// opencode #34278 regression class: the SAME model id, reachable via
// two providers, must resolve to each route's OWN legal tier list, not a static per-model one.
describe("resolveLegalReasoningTiers", () => {
  const reasoningCatalog: ModelCatalog = {
    fetchedAt: "2026-08-25T00:00:00.000Z",
    entries: [
      entry({
        id: "dual-tier-model",
        provider: "openrouter",
        reasoningOptions: [{ type: "effort", values: ["low", "high"] }],
      }),
      entry({
        id: "dual-tier-model",
        provider: "anthropic",
        reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
      }),
    ],
  };

  test("the same model id resolves its own tier list per provider route", () => {
    expect(
      resolveLegalReasoningTiers(
        { model: "dual-tier-model", provider: "openrouter", rerouted: false, viaGateway: false },
        reasoningCatalog,
      ),
    ).toEqual(["low", "high"]);

    expect(
      resolveLegalReasoningTiers(
        { model: "dual-tier-model", provider: "anthropic", rerouted: false, viaGateway: false },
        reasoningCatalog,
      ),
    ).toEqual(["low", "medium", "high"]);
  });

  test("a route with no matching catalog entry returns no tiers", () => {
    expect(
      resolveLegalReasoningTiers(
        { model: "unknown-model", provider: "groq", rerouted: false, viaGateway: false },
        reasoningCatalog,
      ),
    ).toEqual([]);
  });
});

// The shared route-resolution helper extracted after the same
// triplet (session.model ?? resolveDefaultModel fallback, session.provider ?? DEFAULT_PROVIDER,
// then resolveRoute) was independently copy-pasted at four call sites in cli.ts.
describe("resolveSessionRoute", () => {
  test("a session with model/provider both set resolves exactly like a direct resolveRoute call", () => {
    process.env.ANTHROPIC_API_KEY = "fake-test-key";

    const route = resolveSessionRoute(
      { model: "claude-sonnet-5", provider: "anthropic" },
      catalog,
      new Set(["anthropic"]),
      null,
      tmpRoot,
    );

    expect(route).toEqual({
      model: "claude-sonnet-5",
      provider: "anthropic",
      rerouted: false,
      viaGateway: false,
    });
  });

  test("a session with no model at all falls back to resolveDefaultModel's own resolution", () => {
    process.env.SERI_MODEL = "solo-model";
    process.env.SERI_PROVIDER = "groq";
    process.env.GROQ_API_KEY = "fake-test-key";

    const route = resolveSessionRoute({}, catalog, new Set(["groq"]), null, tmpRoot);

    expect(route.model).toBe("solo-model");
    expect(route.provider).toBe("groq");
  });

  test("a session with no provider at all, and nothing configured anywhere, falls back to DEFAULT_PROVIDER", () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const route = resolveSessionRoute(
      { model: "solo-model" },
      catalog,
      new Set(["groq"]),
      null,
      tmpRoot,
    );

    expect(route.provider).toBe("groq");
  });

  // A session with a `model` but no `provider` (a legitimate state — RunSession's own comment,
  // cli.ts) must resolve resolveDefaultModel's own resolved provider, not a hardcoded one: the
  // catalog has no "claude-sonnet-5" entry under "groq" at all, so resolving against the wrong
  // provider here would find no catalog entry and leave the route stuck on it, instead of the
  // provider actually configured (SERI_PROVIDER=anthropic).
  test("a session with a model but no provider resolves the CONFIGURED default provider, not a hardcoded one", () => {
    process.env.SERI_MODEL = "claude-sonnet-5";
    process.env.SERI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "fake-test-key";

    const route = resolveSessionRoute(
      { model: "claude-sonnet-5" },
      catalog,
      new Set(["anthropic"]),
      null,
      tmpRoot,
    );

    expect(route).toEqual({
      model: "claude-sonnet-5",
      provider: "anthropic",
      rerouted: false,
      viaGateway: false,
    });
  });
});
