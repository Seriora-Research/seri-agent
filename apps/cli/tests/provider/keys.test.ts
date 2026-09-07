import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_PROVIDERS } from "@seri/model-catalog";
import { setConfigValue } from "../../src/config/config";
import {
  allProviderKeyStates,
  configuredProviders,
  missingKeyError,
  PROVIDER_API_KEY_NAMES,
  PROVIDER_DISPLAY_NAMES,
  providerKeyState,
  tuiMissingKeyMessage,
} from "../../src/provider/keys";

const ALL_KEY_NAMES = Object.values(PROVIDER_API_KEY_NAMES);
const originalEnv = Object.fromEntries(ALL_KEY_NAMES.map((name) => [name, process.env[name]]));

// Node/Bun coerce process.env.X = undefined to the string "undefined".
function restoreEnv(): void {
  for (const name of ALL_KEY_NAMES) {
    const original = originalEnv[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

let configDir: string;

beforeEach(() => {
  for (const name of ALL_KEY_NAMES) delete process.env[name];
  configDir = mkdtempSync(join(tmpdir(), "seri-keys-test-"));
});

afterEach(() => {
  restoreEnv();
  rmSync(configDir, { recursive: true, force: true });
});

describe("PROVIDER_API_KEY_NAMES", () => {
  test("has exactly one entry per CATALOG_PROVIDERS member", () => {
    expect(Object.keys(PROVIDER_API_KEY_NAMES).sort()).toEqual([...CATALOG_PROVIDERS].sort());
  });

  test("google's key name is the longer GOOGLE_GENERATIVE_AI_API_KEY, not GOOGLE_API_KEY", () => {
    expect(PROVIDER_API_KEY_NAMES.google).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(PROVIDER_API_KEY_NAMES.google).not.toBe("GOOGLE_API_KEY");
  });
});

describe("PROVIDER_DISPLAY_NAMES", () => {
  test("has exactly one entry per CATALOG_PROVIDERS member", () => {
    expect(Object.keys(PROVIDER_DISPLAY_NAMES).sort()).toEqual([...CATALOG_PROVIDERS].sort());
  });

  test("openrouter and openai use their own brand capitalization, not a naive title-case", () => {
    expect(PROVIDER_DISPLAY_NAMES.openrouter).toBe("OpenRouter");
    expect(PROVIDER_DISPLAY_NAMES.openai).toBe("OpenAI");
  });
});

describe("missingKeyError", () => {
  test("produces the exact legacy message for every provider", () => {
    expect(missingKeyError("groq").message).toBe(
      "GROQ_API_KEY is not set. Set it as an environment variable and re-run.",
    );
    expect(missingKeyError("openrouter").message).toBe(
      "OPENROUTER_API_KEY is not set. Set it as an environment variable and re-run.",
    );
    expect(missingKeyError("anthropic").message).toBe(
      "ANTHROPIC_API_KEY is not set. Set it as an environment variable and re-run.",
    );
    expect(missingKeyError("openai").message).toBe(
      "OPENAI_API_KEY is not set. Set it as an environment variable and re-run.",
    );
    expect(missingKeyError("google").message).toBe(
      "GOOGLE_GENERATIVE_AI_API_KEY is not set. Set it as an environment variable and re-run.",
    );
  });
});

describe("tuiMissingKeyMessage", () => {
  test("a missingKeyError becomes a /setup instruction naming the provider's own display name, not the raw env var", () => {
    expect(tuiMissingKeyMessage(missingKeyError("openrouter"))).toBe(
      "No OpenRouter key configured. Run /setup to add one.",
    );
  });

  test("an unrelated Error passes through its own message unchanged", () => {
    expect(tuiMissingKeyMessage(new Error("some other failure"))).toBe("some other failure");
  });

  test("a non-Error throw still stringifies, matching every other catch site's own fallback", () => {
    expect(tuiMissingKeyMessage("raw string throw")).toBe("raw string throw");
  });
});

describe("providerKeyState", () => {
  test("unset when neither env nor config has the key", () => {
    expect(providerKeyState("anthropic", configDir)).toEqual({
      provider: "anthropic",
      keyName: "ANTHROPIC_API_KEY",
      source: "unset",
      masked: undefined,
      hasConfigEntry: false,
    });
  });

  test("config when only config.json has the key", () => {
    setConfigValue("ANTHROPIC_API_KEY", "sk-fake-config-key", configDir);
    const state = providerKeyState("anthropic", configDir);
    expect(state.source).toBe("config");
    expect(state.masked).toBeDefined();
    expect(state.hasConfigEntry).toBe(true);
  });

  test("env when only the environment has the key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-fake-env-key";
    const state = providerKeyState("anthropic", configDir);
    expect(state.source).toBe("env");
    expect(state.hasConfigEntry).toBe(false);
  });

  test("env shadows a config entry — source reports env, but hasConfigEntry stays true", () => {
    setConfigValue("ANTHROPIC_API_KEY", "sk-fake-config-key", configDir);
    process.env.ANTHROPIC_API_KEY = "sk-fake-env-key";
    const state = providerKeyState("anthropic", configDir);
    expect(state.source).toBe("env");
    expect(state.hasConfigEntry).toBe(true);
  });

  test("an empty-string env var reads as unset, not as env", () => {
    process.env.ANTHROPIC_API_KEY = "";
    expect(providerKeyState("anthropic", configDir).source).toBe("unset");
  });
});

describe("configuredProviders", () => {
  test("returns exactly the providers with a truthy key", () => {
    setConfigValue("ANTHROPIC_API_KEY", "sk-fake-config-key", configDir);
    process.env.OPENAI_API_KEY = "sk-fake-env-key";

    expect(configuredProviders(configDir)).toEqual(new Set(["anthropic", "openai"]));
  });

  test("returns an empty set when nothing is configured", () => {
    expect(configuredProviders(configDir)).toEqual(new Set());
  });
});

describe("allProviderKeyStates", () => {
  test("returns exactly one entry per CATALOG_PROVIDERS member, matching providerKeyState per-provider", () => {
    setConfigValue("ANTHROPIC_API_KEY", "sk-fake-config-key", configDir);
    process.env.OPENAI_API_KEY = "sk-fake-env-key";

    const states = allProviderKeyStates(configDir);
    expect(states.map((s) => s.provider)).toEqual([...CATALOG_PROVIDERS]);

    for (const provider of CATALOG_PROVIDERS) {
      const batched = states.find((s) => s.provider === provider);
      expect(batched).toEqual(providerKeyState(provider, configDir));
    }
  });
});
