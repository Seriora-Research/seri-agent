import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelCatalogEntry } from "@seri/model-catalog";
import { loadConfig, setConfigValue } from "../../src/config/config";
import {
  ROUTABLE_ROLES,
  type RoutableRole,
  effortForRole,
  parseRolePins,
  realizedRoute,
  resolveRoleRoute,
} from "../../src/subagents/routes";
import { DISPATCHABLE_ROLES } from "../../src/subagents/roles";

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

const catalog: ModelCatalog = {
  fetchedAt: "2026-08-28T00:00:00.000Z",
  entries: [
    entry({ id: "claude-sonnet-5", provider: "anthropic" }),
    entry({ id: "anthropic/claude-sonnet-5", provider: "openrouter" }),
    entry({ id: "solo-model", provider: "groq" }),
    entry({ id: "shared-model", provider: "groq" }),
    entry({ id: "groq/shared-model", provider: "openrouter" }),
  ],
};

const parent = {
  model: "solo-model",
  provider: "groq" as const,
  rerouted: false,
  viaGateway: false,
};

const PIN_ENV_KEYS = [
  "SERI_ROLE_ORACLE_MODEL",
  "SERI_ROLE_ORACLE_PROVIDER",
  "SERI_ROLE_ARCHIVIST_MODEL",
  "SERI_ROLE_ARCHIVIST_PROVIDER",
  "SERI_ROLE_EXPLORE_MODEL",
  "SERI_ROLE_EXPLORE_PROVIDER",
] as const;
const originalEnv = Object.fromEntries(PIN_ENV_KEYS.map((name) => [name, process.env[name]]));

function restoreEnv(): void {
  for (const name of PIN_ENV_KEYS) {
    const original = originalEnv[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

afterEach(restoreEnv);

describe("parseRolePins", () => {
  test("a complete config pair for oracle is a pin", () => {
    const pins = parseRolePins(
      {},
      {
        SERI_ROLE_ORACLE_MODEL: "claude-sonnet-5",
        SERI_ROLE_ORACLE_PROVIDER: "anthropic",
      },
    );
    expect(pins.oracle).toEqual({ model: "claude-sonnet-5", provider: "anthropic" });
    expect(pins.explore).toBeUndefined();
  });

  test("env wins over config for the same role", () => {
    const pins = parseRolePins(
      {
        SERI_ROLE_ORACLE_MODEL: "solo-model",
        SERI_ROLE_ORACLE_PROVIDER: "groq",
      },
      {
        SERI_ROLE_ORACLE_MODEL: "claude-sonnet-5",
        SERI_ROLE_ORACLE_PROVIDER: "anthropic",
      },
    );
    expect(pins.oracle).toEqual({ model: "solo-model", provider: "groq" });
  });

  test("model without a valid provider from the same source is unset, not mixed", () => {
    const pins = parseRolePins(
      { SERI_ROLE_ORACLE_MODEL: "solo-model" },
      {
        SERI_ROLE_ORACLE_MODEL: "claude-sonnet-5",
        SERI_ROLE_ORACLE_PROVIDER: "anthropic",
      },
    );
    expect(pins.oracle).toBeUndefined();
  });

  test("unknown provider string is unset, not mixed with the parent provider", () => {
    const pins = parseRolePins(
      {},
      {
        SERI_ROLE_ORACLE_MODEL: "solo-model",
        SERI_ROLE_ORACLE_PROVIDER: "mistral",
      },
    );
    expect(pins.oracle).toBeUndefined();
  });

  test("empty model string is unset", () => {
    const pins = parseRolePins(
      {},
      {
        SERI_ROLE_ORACLE_MODEL: "",
        SERI_ROLE_ORACLE_PROVIDER: "groq",
      },
    );
    expect(pins.oracle).toBeUndefined();
  });

  test("an empty env model does not fall through to a complete config pair", () => {
    const pins = parseRolePins(
      { SERI_ROLE_ORACLE_MODEL: "" },
      {
        SERI_ROLE_ORACLE_MODEL: "claude-sonnet-5",
        SERI_ROLE_ORACLE_PROVIDER: "anthropic",
      },
    );
    expect(pins.oracle).toBeUndefined();
  });
});

describe("resolveRoleRoute", () => {
  test("no pin inherits the parent pair", () => {
    const route = resolveRoleRoute("explore", parent, {}, catalog, new Set(["groq"]), null);
    expect(route).toEqual({
      model: "solo-model",
      provider: "groq",
      rerouted: false,
      viaGateway: false,
      inherited: true,
    });
  });

  test("a complete pin whose provider is configured uses that pair", () => {
    const route = resolveRoleRoute(
      "oracle",
      parent,
      { oracle: { model: "claude-sonnet-5", provider: "anthropic" } },
      catalog,
      new Set(["groq", "anthropic"]),
      null,
    );
    expect(route).toEqual({
      model: "claude-sonnet-5",
      provider: "anthropic",
      rerouted: false,
      viaGateway: false,
      inherited: false,
    });
  });

  test("a pin whose provider has no key but a sibling does is rerouted, not inherited", () => {
    const route = resolveRoleRoute(
      "oracle",
      parent,
      { oracle: { model: "anthropic/claude-sonnet-5", provider: "openrouter" } },
      catalog,
      new Set(["anthropic"]),
      null,
    );
    expect(route.inherited).toBe(false);
    expect(route.rerouted).toBe(true);
    expect(route.provider).toBe("anthropic");
    expect(route.model).toBe("claude-sonnet-5");
    expect(route.viaGateway).toBe(false);
  });

  test("a pin with no local key and a covering plan uses the gateway", () => {
    const gatewayCatalog: ModelCatalog = {
      fetchedAt: catalog.fetchedAt,
      entries: [
        entry({
          id: "shared-model",
          provider: "groq",
          pricing: { inputPerMTok: 1, outputPerMTok: 1 },
        }),
        entry({
          id: "groq/shared-model",
          provider: "openrouter",
          pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        }),
      ],
    };
    const route = resolveRoleRoute(
      "archivist",
      parent,
      { archivist: { model: "shared-model", provider: "groq" } },
      gatewayCatalog,
      new Set(),
      "free",
    );
    expect(route).toEqual({
      model: "groq/shared-model",
      provider: "openrouter",
      rerouted: false,
      viaGateway: true,
      inherited: false,
    });
  });

  test("archivist is a routing target even though it is not dispatchable", () => {
    expect((DISPATCHABLE_ROLES as readonly string[]).includes("archivist")).toBe(false);
    const route = resolveRoleRoute(
      "archivist",
      parent,
      { archivist: { model: "claude-sonnet-5", provider: "anthropic" } },
      catalog,
      new Set(["anthropic"]),
      null,
    );
    expect(route.inherited).toBe(false);
    expect(route.model).toBe("claude-sonnet-5");
  });
});

describe("effortForRole", () => {
  const parentEffort = {
    provider: "groq" as const,
    modelId: "solo-model",
    reasoningEffort: "high" as string | undefined,
  };

  test("same (provider, modelId) copies the parent string", () => {
    expect(
      effortForRole(parentEffort, { provider: "groq", modelId: "solo-model" }),
    ).toBe("high");
  });

  test("a different pair omits effort even when the parent string is high", () => {
    // Negative control: copying parent high onto a cheap/different child is the bug this
    // function exists to prevent. If this assertion is deleted, inherit-always looks green.
    expect(
      effortForRole(parentEffort, { provider: "anthropic", modelId: "claude-sonnet-5" }),
    ).toBeUndefined();
  });

  test("same provider with a different model id still omits", () => {
    expect(effortForRole(parentEffort, { provider: "groq", modelId: "other-model" })).toBeUndefined();
  });
});

describe("realizedRoute", () => {
  test("a failed construct falls back to the parent pair and marks inherited", () => {
    const intended = resolveRoleRoute(
      "oracle",
      parent,
      { oracle: { model: "claude-sonnet-5", provider: "anthropic" } },
      catalog,
      new Set(["anthropic"]),
      null,
    );
    expect(intended.inherited).toBe(false);
    expect(
      realizedRoute(intended, parent, false),
    ).toEqual({
      model: "solo-model",
      provider: "groq",
      rerouted: false,
      viaGateway: false,
      inherited: true,
    });
  });

  test("a successful construct keeps the intended pair", () => {
    const intended = resolveRoleRoute(
      "oracle",
      parent,
      { oracle: { model: "claude-sonnet-5", provider: "anthropic" } },
      catalog,
      new Set(["anthropic"]),
      null,
    );
    expect(realizedRoute(intended, parent, true)).toEqual(intended);
  });
});

describe("DISPATCHABLE_ROLES vs RoutableRole", () => {
  test("oracle is dispatchable; archivist is only routable", () => {
    expect(DISPATCHABLE_ROLES).toContain("oracle");
    expect((DISPATCHABLE_ROLES as readonly string[]).includes("archivist")).toBe(false);
    expect(ROUTABLE_ROLES).toEqual(["explore", "plan", "code", "test", "oracle", "archivist"]);
    const _archivist: RoutableRole = "archivist";
    expect(_archivist).toBe("archivist");
  });
});

describe("parseRolePins reads env then config from a real config dir", () => {
  test("load-shaped: config file pair is visible when env is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-role-pins-"));
    try {
      setConfigValue("SERI_ROLE_ORACLE_MODEL", "claude-sonnet-5", dir);
      setConfigValue("SERI_ROLE_ORACLE_PROVIDER", "anthropic", dir);
      // parseRolePins is the pure seam; the file is the same Record loadConfig returns.
      const pins = parseRolePins(process.env, loadConfig(dir));
      expect(pins.oracle).toEqual({ model: "claude-sonnet-5", provider: "anthropic" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
