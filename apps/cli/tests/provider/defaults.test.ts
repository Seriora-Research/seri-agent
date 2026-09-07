import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_PROVIDERS } from "@seri/model-catalog";
import { CONFIG_FILENAME } from "../../src/config/config";
import {
  isModelProvider,
  persistDefaultModel,
  resolveDefaultModel,
} from "../../src/provider/defaults";
import { DEFAULT_MODEL } from "../../src/provider/groq";

const originalModel = process.env.SERI_MODEL;
const originalProvider = process.env.SERI_PROVIDER;
const originalHome = process.env.HOME;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

let tmpRoot: string;

beforeEach(() => {
  delete process.env.SERI_MODEL;
  delete process.env.SERI_PROVIDER;

  tmpRoot = mkdtempSync(join(tmpdir(), "seri-defaults-test-"));
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  restoreEnv("SERI_MODEL", originalModel);
  restoreEnv("SERI_PROVIDER", originalProvider);
  restoreEnv("HOME", originalHome);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("isModelProvider", () => {
  test("accepts every provider CATALOG_PROVIDERS lists", () => {
    expect(CATALOG_PROVIDERS.length).toBeGreaterThan(0);
    for (const p of CATALOG_PROVIDERS) {
      expect(isModelProvider(p)).toBe(true);
    }
  });

  test("rejects an unrecognized value", () => {
    expect(isModelProvider("mistral")).toBe(false);
    expect(isModelProvider("")).toBe(false);
  });
});

describe("resolveDefaultModel", () => {
  test("nothing set: falls back to DEFAULT_MODEL, no provider requested", () => {
    expect(resolveDefaultModel()).toEqual({
      model: DEFAULT_MODEL,
      provider: undefined,
    });
  });

  test("config-only: returns the persisted pair", () => {
    persistDefaultModel({ model: "picked-model", provider: "openrouter" });
    expect(resolveDefaultModel()).toEqual({
      model: "picked-model",
      provider: "openrouter",
    });
  });

  test("env beats config for both keys", () => {
    persistDefaultModel({ model: "config-model", provider: "openrouter" });
    process.env.SERI_MODEL = "env-model";
    process.env.SERI_PROVIDER = "anthropic";
    expect(resolveDefaultModel()).toEqual({
      model: "env-model",
      provider: "anthropic",
    });
  });

  test("env overriding only SERI_MODEL ignores a stale persisted provider, not mixes it in", () => {
    persistDefaultModel({ model: "claude-sonnet-4-5", provider: "anthropic" });
    process.env.SERI_MODEL = "llama-3.3-70b-versatile";
    expect(resolveDefaultModel()).toEqual({
      model: "llama-3.3-70b-versatile",
      provider: undefined,
    });
  });

  test("SERI_PROVIDER='' falls through to the config/default, the deliberate ||", () => {
    persistDefaultModel({ model: "picked-model", provider: "openrouter" });
    process.env.SERI_PROVIDER = "";
    expect(resolveDefaultModel()).toEqual({
      model: "picked-model",
      provider: "openrouter",
    });
  });

  test("SERI_PROVIDER='bogus' is not a request, provider is undefined, does not throw", () => {
    process.env.SERI_PROVIDER = "bogus";
    expect(resolveDefaultModel()).toEqual({
      model: DEFAULT_MODEL,
      provider: undefined,
    });
  });

  test("SERI_MODEL set with no SERI_PROVIDER: no provider requested", () => {
    process.env.SERI_MODEL = "env-model";
    expect(resolveDefaultModel()).toEqual({
      model: "env-model",
      provider: undefined,
    });
  });
});

describe("persistDefaultModel", () => {
  test("writes both keys, readable back by a subsequent resolveDefaultModel", () => {
    persistDefaultModel({ model: "written-model", provider: "google" });
    expect(resolveDefaultModel()).toEqual({
      model: "written-model",
      provider: "google",
    });
  });

  test("a sabotaged persist leaves the previously persisted pair unchanged, not a mismatch", () => {
    persistDefaultModel({ model: "first-model", provider: "openrouter" });

    const configPath = join(tmpRoot, ".seri", CONFIG_FILENAME);
    chmodSync(configPath, 0o444);

    try {
      expect(() => persistDefaultModel({ model: "second-model", provider: "anthropic" })).toThrow();
      expect(resolveDefaultModel()).toEqual({
        model: "first-model",
        provider: "openrouter",
      });
    } finally {
      chmodSync(configPath, 0o644);
    }
  });
});

describe("configDir isolation", () => {
  test("both functions read/write the given configDir, not the ambient default", () => {
    persistDefaultModel({ model: "ambient-model", provider: "openrouter" });

    const callerDir = mkdtempSync(join(tmpdir(), "seri-defaults-test-caller-"));
    try {
      persistDefaultModel({ model: "caller-model", provider: "anthropic" }, callerDir);

      expect(resolveDefaultModel(callerDir)).toEqual({
        model: "caller-model",
        provider: "anthropic",
      });

      expect(resolveDefaultModel()).toEqual({
        model: "ambient-model",
        provider: "openrouter",
      });
    } finally {
      rmSync(callerDir, { recursive: true, force: true });
    }
  });
});
