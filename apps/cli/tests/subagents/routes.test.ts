import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelCatalogEntry } from "@seri/model-catalog";
import { loadConfig, setConfigValue } from "../../src/config/config";
import { BUILTIN_AGENTS } from "../../src/subagents/registry";
import {
  effortForChild,
  effortForRole,
  parseRolePins,
  pinFromTask,
  ROUTABLE_ROLES,
  type RoutableRole,
  realizedRoute,
  resolveChildRoute,
  resolveRoleRoute,
  roleConstructionWarning,
} from "../../src/subagents/routes";

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
  credential: "key" as const,
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
      credential: "key" as const,
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
      credential: "key" as const,
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
    expect(route.credential).toBe("key");
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
      credential: "gateway" as const,
      inherited: false,
    });
  });

  test("archivist is a routing target even though it is not dispatchable", () => {
    expect(BUILTIN_AGENTS.some((spec) => spec.name === "archivist")).toBe(false);
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
    expect(effortForRole(parentEffort, { provider: "groq", modelId: "solo-model" })).toBe("high");
  });

  test("a different pair omits effort even when the parent string is high", () => {


    expect(
      effortForRole(parentEffort, { provider: "anthropic", modelId: "claude-sonnet-5" }),
    ).toBeUndefined();
  });

  test("same provider with a different model id still omits", () => {
    expect(
      effortForRole(parentEffort, { provider: "groq", modelId: "other-model" }),
    ).toBeUndefined();
  });
});

describe("pinFromTask", () => {
  test("a complete task pair is a pin", () => {
    expect(pinFromTask({ model: "claude-sonnet-5", provider: "anthropic" })).toEqual({
      model: "claude-sonnet-5",
      provider: "anthropic",
    });
  });

  test("a model without a provider is incomplete, not mixed with anything", () => {
    expect(pinFromTask({ model: "claude-sonnet-5" })).toBeUndefined();
    expect(pinFromTask({ model: "claude-sonnet-5", provider: "not-a-provider" })).toBeUndefined();
    expect(pinFromTask({ model: "", provider: "anthropic" })).toBeUndefined();
    expect(pinFromTask(undefined)).toBeUndefined();
  });
});

describe("resolveChildRoute", () => {
  const rolePin = { oracle: { model: "solo-model", provider: "groq" as const } };

  test("a complete task pair wins over a role pin", () => {
    const route = resolveChildRoute(
      "oracle",
      parent,
      rolePin,
      { model: "claude-sonnet-5", provider: "anthropic" },
      catalog,
      new Set(["anthropic", "groq"]),
      null,
    );
    expect(route).toEqual({
      model: "claude-sonnet-5",
      provider: "anthropic",
      credential: "key" as const,
      rerouted: false,
      inherited: false,
    });
  });

  test("a task model without a provider falls through to the role pin", () => {
    const route = resolveChildRoute(
      "oracle",
      parent,
      { oracle: { model: "claude-sonnet-5", provider: "anthropic" } },
      { model: "shared-model", effort: "high" },
      catalog,
      new Set(["anthropic"]),
      null,
    );
    expect(route.model).toBe("claude-sonnet-5");
    expect(route.provider).toBe("anthropic");
    expect(route.inherited).toBe(false);
  });

  test("no task pair and no role pin inherits the parent", () => {
    const route = resolveChildRoute(
      "oracle",
      parent,
      {},
      { effort: "high" },
      catalog,
      new Set(),
      null,
    );
    expect(route).toMatchObject({
      model: "solo-model",
      provider: "groq",
      inherited: true,
    });
  });
});

describe("effortForChild", () => {
  const parentEffort = {
    provider: "groq" as const,
    modelId: "solo-model",
    reasoningEffort: "medium" as const,
  };

  test("an explicit effort is forwarded even when the pair differs", () => {
    expect(
      effortForChild(parentEffort, { provider: "anthropic", modelId: "claude-sonnet-5" }, "high"),
    ).toBe("high");
  });

  test("omitted effort on a different pair is still undefined", () => {
    expect(
      effortForChild(parentEffort, { provider: "anthropic", modelId: "claude-sonnet-5" }),
    ).toBeUndefined();
  });

  test("empty effort string does not override inherit-iff", () => {
    expect(effortForChild(parentEffort, { provider: "groq", modelId: "solo-model" }, "")).toBe(
      "medium",
    );
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
    expect(realizedRoute(intended, parent, false)).toEqual({
      model: "solo-model",
      provider: "groq",
      rerouted: false,
      credential: "key" as const,
      inherited: true,
    });
    const warning = roleConstructionWarning("oracle", intended, "ANTHROPIC_API_KEY is not set");
    expect(warning).toContain('role "oracle" could not use');
    expect(warning).toContain("anthropic/claude-sonnet-5");
    expect(warning).toContain("ANTHROPIC_API_KEY is not set");
  });

  test("the construction-failure warning names the role, not a generic construction failed", () => {
    const intended = {
      model: "claude-sonnet-5",
      provider: "anthropic" as const,
      credential: "key" as const,
      rerouted: false,
      inherited: false,
    };
    const warning = roleConstructionWarning("plan", intended, "boom");


    expect(warning).toContain('role "plan" could not use');
    expect(warning).not.toContain('role "oracle"');
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

describe("BUILTIN_AGENTS vs RoutableRole", () => {
  test("explore and plan are dispatchable; dropped names stay routable so a file cannot reclaim them", () => {
    expect(BUILTIN_AGENTS.map((spec) => spec.name)).toEqual(["explore", "plan"]);
    expect(BUILTIN_AGENTS.some((spec) => spec.name === "archivist")).toBe(false);
    expect(BUILTIN_AGENTS.some((spec) => spec.name === "oracle")).toBe(false);
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

      const pins = parseRolePins(process.env, loadConfig(dir));
      expect(pins.oracle).toEqual({ model: "claude-sonnet-5", provider: "anthropic" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a subagent pinned to a subscribed provider", () => {




  const grokCatalog: ModelCatalog = {
    fetchedAt: "2026-08-28T00:00:00.000Z",
    entries: [entry({ id: "grok-4.5", provider: "xai" }), ...catalog.entries],
  };

  test("a task-pinned role resolves to the subscription, with no API key configured", () => {
    const route = resolveChildRoute(
      undefined,
      parent,
      {},
      { model: "grok-4.5", provider: "xai" },
      grokCatalog,
      new Set(),
      null,
      new Set(["xai"]),
    );
    expect(route.provider).toBe("xai");
    expect(route.credential).toBe("subscription");
    expect(route.inherited).toBe(false);
  });

  test("an env-pinned role resolves to the subscription too", () => {
    const route = resolveRoleRoute(
      "oracle",
      parent,
      { oracle: { model: "grok-4.5", provider: "xai" } },
      grokCatalog,
      new Set(),
      null,
      new Set(["xai"]),
    );
    expect(route.credential).toBe("subscription");
  });

  test("with no subscription connected the same pin still reports the key path", () => {
    const route = resolveRoleRoute(
      "oracle",
      parent,
      { oracle: { model: "grok-4.5", provider: "xai" } },
      grokCatalog,
      new Set(["xai"]),
      null,
      new Set(),
    );
    expect(route.credential).toBe("key");
  });
});
