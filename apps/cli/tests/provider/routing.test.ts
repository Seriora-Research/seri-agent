import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelCatalogEntry } from "@seri/model-catalog";
import { clearCodexSubscriptionIgnore, ignoreCodexSubscription } from "../../src/auth/codexIgnore";
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
      credential: "key",
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
      credential: "key",
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
      credential: "key",
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
      credential: "key",
    });
    expect(() => getModel(route.model, route.provider, "test-session-id")).toThrow(
      "OPENROUTER_API_KEY is not set. Set it as an environment variable and re-run.",
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
      credential: "key",
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
      credential: "key",
    });
  });

  describe("Rule 4: route via gateway", () => {
    test("no key anywhere, an OpenRouter sibling exists, and the plan covers it: the gateway credential, routed to the OpenRouter entry", () => {
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
        credential: "gateway",
      });
    });

    test("no key anywhere and plan: null leaves the credential on the key path, unchanged from today", () => {
      const route = resolveRoute(catalog, { model: "shared-model", provider: "groq" }, new Set());
      expect(route.credential).toBe("key");
    });

    // A logged-in session whose /account-status fetch failed (or never ran) used to
    // fall through to missingKeyError for OPENROUTER_API_KEY — the wrong refusal:
    // the WorkOS session is the credential, and the server is the quota authority.
    test("a usable hosted login with plan: null still routes via the gateway", () => {
      const viaGroq = resolveRoute(
        catalog,
        { model: "shared-model", provider: "groq" },
        new Set(),
        null,
        undefined,
        true,
      );
      expect(viaGroq).toEqual({
        model: "groq/shared-model",
        provider: "openrouter",
        rerouted: false,
        credential: "gateway",
      });

      const viaOpenRouter = resolveRoute(
        catalog,
        { model: "anthropic/claude-sonnet-5", provider: "openrouter" },
        new Set(),
        null,
        undefined,
        true,
      );
      expect(viaOpenRouter).toEqual({
        model: "anthropic/claude-sonnet-5",
        provider: "openrouter",
        rerouted: false,
        credential: "gateway",
      });
    });

    test("a usable hosted login does not invent a gateway route for a model with no OpenRouter sibling", () => {
      const route = resolveRoute(
        catalog,
        { model: "solo-model", provider: "groq" },
        new Set(),
        null,
        undefined,
        true,
      );
      expect(route.credential).toBe("key");
    });

    // A provider-exclusive model (no OpenRouter-catalog sibling at all) never shows a gateway credential,
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
        credential: "key",
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
      expect(route.credential).toBe("key");
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
        credential: "gateway",
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
        credential: "key",
      });
    });

    test("a leftover OpenRouter key is unused when a seri plan covers the same provider", () => {
      const route = resolveRoute(
        catalog,
        { model: "anthropic/claude-sonnet-5", provider: "openrouter" },
        new Set(["openrouter"]),
        "pro",
      );
      expect(route).toEqual({
        model: "anthropic/claude-sonnet-5",
        provider: "openrouter",
        rerouted: false,
        credential: "gateway",
      });
    });

    test("a leftover OpenRouter key is used when no seri plan is active", () => {
      const route = resolveRoute(
        catalog,
        { model: "anthropic/claude-sonnet-5", provider: "openrouter" },
        new Set(["openrouter"]),
        null,
      );
      expect(route).toEqual({
        model: "anthropic/claude-sonnet-5",
        provider: "openrouter",
        rerouted: false,
        credential: "key",
      });
    });

    // Regression: a configured sibling still wins over gateway coverage — when both a sibling key
    // AND planCoverage are available, the reroute-to-sibling outcome is returned, never
    // credential: "gateway".
    test("regression: a configured sibling wins over gateway coverage", () => {
      const route = resolveRoute(
        catalog,
        { model: "anthropic/claude-sonnet-5", provider: "openrouter" },
        new Set(["anthropic"]),
        "pro",
      );
      expect(route.rerouted).toBe(true);
      expect(route.credential).toBe("key");
    });
  });
});

// The SAME model id, reachable via
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
        { model: "dual-tier-model", provider: "openrouter", rerouted: false, credential: "key" },
        reasoningCatalog,
      ),
    ).toEqual(["low", "high"]);

    expect(
      resolveLegalReasoningTiers(
        { model: "dual-tier-model", provider: "anthropic", rerouted: false, credential: "key" },
        reasoningCatalog,
      ),
    ).toEqual(["low", "medium", "high"]);
  });

  test("a route with no matching catalog entry returns no tiers", () => {
    expect(
      resolveLegalReasoningTiers(
        { model: "unknown-model", provider: "groq", rerouted: false, credential: "key" },
        reasoningCatalog,
      ),
    ).toEqual([]);
  });
});

// The shared route-resolution helper extracted after the same
// triplet (session.model ?? resolveDefaultModel fallback, session.provider ?? DEFAULT_PROVIDER,
// then resolveRoute) was independently copy-pasted at four call sites in cli.ts.
describe("resolveSessionRoute", () => {
  test("a logged-in profile with no keys and no fetched plan uses the gateway, not a missing OpenRouter key", () => {
    writeFileSync(
      join(tmpRoot, "auth.json"),
      JSON.stringify({
        accessToken: "at",
        refreshToken: "rt",
        userId: "user-0",
        email: "a@example.com",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const route = resolveSessionRoute(
      { model: "anthropic/claude-sonnet-5", provider: "openrouter" },
      catalog,
      new Set(),
      null,
      tmpRoot,
    );

    expect(route).toEqual({
      model: "anthropic/claude-sonnet-5",
      provider: "openrouter",
      rerouted: false,
      credential: "gateway",
    });
  });

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
      credential: "key",
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
      credential: "key",
    });
  });
});

describe("a connected subscription as a credential", () => {
  const grokCatalog: ModelCatalog = {
    fetchedAt: "",
    entries: [
      entry({ id: "grok-4.5", provider: "xai" }),
      entry({ id: "x-ai/grok-4.5", provider: "openrouter" }),
    ],
  };

  test("a subscribed provider satisfies rule 1 with no API key at all", () => {
    const route = resolveRoute(
      grokCatalog,
      { model: "grok-4.5", provider: "xai" },
      new Set(),
      null,
      new Set(["xai"]),
    );
    expect(route.rerouted).toBe(false);
    expect(route.provider).toBe("xai");
    expect(route.credential).toBe("subscription");
  });

  // Both credentials are the user's own, so the tie-break is marginal cost: the subscription is
  // already paid and flat-rate while the key bills per token.
  test("a subscription beats an API key on the same provider", () => {
    const route = resolveRoute(
      grokCatalog,
      { model: "grok-4.5", provider: "xai" },
      new Set(["xai"]),
      null,
      new Set(["xai"]),
    );
    expect(route.credential).toBe("subscription");
  });

  // No new precedence rule: NATIVE_PROVIDERS.xai makes byRoutePriority prefer xai over the
  // aggregator, and the alias in routeKey is what puts them in one group to be compared at all.
  test("a grok request with only an OpenRouter key reroutes there, but a subscription keeps it native", () => {
    const viaKey = resolveRoute(
      grokCatalog,
      { model: "grok-4.5", provider: "xai" },
      new Set(["openrouter"]),
      null,
    );
    expect(viaKey.rerouted).toBe(true);
    expect(viaKey.provider).toBe("openrouter");
    expect(viaKey.credential).toBe("key");

    const viaSubscription = resolveRoute(
      grokCatalog,
      { model: "grok-4.5", provider: "xai" },
      new Set(["openrouter"]),
      null,
      new Set(["xai"]),
    );
    expect(viaSubscription.rerouted).toBe(false);
    expect(viaSubscription.provider).toBe("xai");
    expect(viaSubscription.credential).toBe("subscription");
  });

  test("an openai ChatGPT-plan subscription satisfies rule 1 with no API key", () => {
    const openaiCatalog: ModelCatalog = {
      fetchedAt: "",
      entries: [entry({ id: "gpt-5.6-terra", provider: "openai" })],
    };
    const route = resolveRoute(
      openaiCatalog,
      { model: "gpt-5.6-terra", provider: "openai" },
      new Set(),
      null,
      new Set(["openai"]),
    );
    expect(route.rerouted).toBe(false);
    expect(route.provider).toBe("openai");
    expect(route.credential).toBe("subscription");
  });

  test("an empty subscription set leaves every existing route unchanged", () => {
    const route = resolveRoute(
      grokCatalog,
      { model: "grok-4.5", provider: "xai" },
      new Set(["xai"]),
      null,
      new Set(),
    );
    expect(route.credential).toBe("key");
  });
});

describe("Codex profile ignore vs an OpenAI key", () => {
  const openaiCatalog: ModelCatalog = {
    fetchedAt: "",
    entries: [entry({ id: "gpt-5.6-terra", provider: "openai" })],
  };
  let codexHome: string;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "seri-routing-codex-"));
    process.env.CODEX_HOME = codexHome;
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok", account_id: "acct" },
      }),
    );
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  test("a ChatGPT plan plus an OpenAI key uses the subscription", () => {
    const route = resolveSessionRoute(
      { model: "gpt-5.6-terra", provider: "openai" },
      openaiCatalog,
      new Set(["openai"]),
      null,
      tmpRoot,
    );
    expect(route.credential).toBe("subscription");
  });

  test("ignoring the plan falls back to the OpenAI key", () => {
    ignoreCodexSubscription(tmpRoot);
    const ignored = resolveSessionRoute(
      { model: "gpt-5.6-terra", provider: "openai" },
      openaiCatalog,
      new Set(["openai"]),
      null,
      tmpRoot,
    );
    expect(ignored.credential).toBe("key");
    clearCodexSubscriptionIgnore(tmpRoot);
    const restored = resolveSessionRoute(
      { model: "gpt-5.6-terra", provider: "openai" },
      openaiCatalog,
      new Set(["openai"]),
      null,
      tmpRoot,
    );
    expect(restored.credential).toBe("subscription");
  });
});
