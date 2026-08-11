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
  providerKeyState,
  tuiMissingKeyMessage,
} from "../../src/provider/keys";

const ALL_KEY_NAMES = Object.values(PROVIDER_API_KEY_NAMES);
const originalEnv = Object.fromEntries(ALL_KEY_NAMES.map((name) => [name, process.env[name]]));

// `.claude/rules/code-quality.md`'s own fix pattern: delete when the original was unset, never
// reassign `undefined` (which Node/Bun coerce to the literal string "undefined").
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

  // Negative control: google's env var is the longer, SDK-implicit name, not the shorter one a
  // naive reader might guess — asserting the wrong value is ALSO not the value here is what makes
  // this check meaningful rather than vacuously true.
  test("google's key name is the longer GOOGLE_GENERATIVE_AI_API_KEY, not GOOGLE_API_KEY", () => {
    expect(PROVIDER_API_KEY_NAMES.google).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(PROVIDER_API_KEY_NAMES.google).not.toBe("GOOGLE_API_KEY");
  });
});

describe("missingKeyError", () => {
  test("produces the exact legacy message for every provider", () => {
    expect(missingKeyError("groq").message).toBe(
      "GROQ_API_KEY is not set. Run: seri config set GROQ_API_KEY <your-key>",
    );
    expect(missingKeyError("openrouter").message).toBe(
      "OPENROUTER_API_KEY is not set. Run: seri config set OPENROUTER_API_KEY <your-key>",
    );
    expect(missingKeyError("anthropic").message).toBe(
      "ANTHROPIC_API_KEY is not set. Run: seri config set ANTHROPIC_API_KEY <your-key>",
    );
    expect(missingKeyError("openai").message).toBe(
      "OPENAI_API_KEY is not set. Run: seri config set OPENAI_API_KEY <your-key>",
    );
    expect(missingKeyError("google").message).toBe(
      "GOOGLE_GENERATIVE_AI_API_KEY is not set. Run: seri config set GOOGLE_GENERATIVE_AI_API_KEY <your-key>",
    );
  });
});

// The TUI-only counterpart (cli.ts's runTurn, the one call site reachable exclusively from inside
// an already-running TUI session) — a real user hitting the exact scenario a live session produced
// (picked an OpenRouter model via /model with no OPENROUTER_API_KEY configured, see PR discussion):
// this must point at /setup, not the non-interactive `seri config set` instruction the user cannot
// act on from inside Ink.
describe("tuiMissingKeyMessage", () => {
  test("a missingKeyError becomes a /setup instruction naming the provider's own key", () => {
    expect(tuiMissingKeyMessage(missingKeyError("openrouter"))).toBe(
      "OPENROUTER_API_KEY is not set. Run /setup to add a key.",
    );
  });

  // Negative control: the rewrite must not eat every error, only this one shape — an unrelated
  // failure keeps its own message so the user still sees the real cause.
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

  // Bug fixed here (code-review, PR #73): `hasConfigEntry` must stay true even though `source`
  // reports "env" (env wins for display/masking, matching getApiKey's own precedence) — this is
  // the fact /setup's own `removable` needs, and the bug was reading `source === "config"` for
  // that instead, which is always false in exactly this state.
  test("env shadows a config entry — source reports env, but hasConfigEntry stays true", () => {
    setConfigValue("ANTHROPIC_API_KEY", "sk-fake-config-key", configDir);
    process.env.ANTHROPIC_API_KEY = "sk-fake-env-key";
    const state = providerKeyState("anthropic", configDir);
    expect(state.source).toBe("env");
    expect(state.hasConfigEntry).toBe(true);
  });

  // getApiKey's own deliberate `||`, not `??`: an env var set to "" must fall through to config,
  // and with nothing in config either, that reads as unset — not as a valid-looking empty key.
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

// Code-review finding (PR #73, round 3, item #8): decideSetupOpen (tui/commands.ts) used to call
// providerKeyState once per CATALOG_PROVIDERS member -- five separate loadConfig reads. This is
// the batched replacement, one loadConfig call for all five.
describe("allProviderKeyStates", () => {
  test("returns exactly one entry per CATALOG_PROVIDERS member, matching providerKeyState per-provider", () => {
    setConfigValue("ANTHROPIC_API_KEY", "sk-fake-config-key", configDir);
    process.env.OPENAI_API_KEY = "sk-fake-env-key";

    const states = allProviderKeyStates(configDir);
    expect(states.map((s) => s.provider)).toEqual([...CATALOG_PROVIDERS]);
    // Same result as calling providerKeyState individually for every provider -- proving the
    // batched read didn't change what each row resolves to, only how many reads it costs.
    for (const provider of CATALOG_PROVIDERS) {
      const batched = states.find((s) => s.provider === provider);
      expect(batched).toEqual(providerKeyState(provider, configDir));
    }
  });
});
