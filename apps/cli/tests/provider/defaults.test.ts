import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_PROVIDERS } from "@seri/model-catalog";
import { DEFAULT_MODEL } from "../../src/provider/groq";
import {
  DEFAULT_PROVIDER,
  isModelProvider,
  persistDefaultModel,
  resolveDefaultModel,
} from "../../src/provider/defaults";

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
  // Point the config dir at an empty temp dir so a real config.json on this machine can never
  // supply SERI_MODEL/SERI_PROVIDER and mask the "nothing set" case.
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
  // Derived from CATALOG_PROVIDERS itself (not a second, hand-written parallel list): the
  // regression this guards is isModelProvider silently drifting out of sync with its own stated
  // source of truth, which a hardcoded expected-list here couldn't catch — both sides would drift
  // together.
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
  test("nothing set: falls back to DEFAULT_MODEL/groq", () => {
    expect(resolveDefaultModel()).toEqual({ model: DEFAULT_MODEL, provider: "groq" });
  });

  test("config-only: returns the persisted pair", () => {
    persistDefaultModel({ model: "picked-model", provider: "openrouter" });
    expect(resolveDefaultModel()).toEqual({ model: "picked-model", provider: "openrouter" });
  });

  test("env beats config for both keys", () => {
    persistDefaultModel({ model: "config-model", provider: "openrouter" });
    process.env.SERI_MODEL = "env-model";
    process.env.SERI_PROVIDER = "anthropic";
    expect(resolveDefaultModel()).toEqual({ model: "env-model", provider: "anthropic" });
  });

  test("SERI_PROVIDER='' falls through to the config/default, the deliberate ||", () => {
    persistDefaultModel({ model: "picked-model", provider: "openrouter" });
    process.env.SERI_PROVIDER = "";
    expect(resolveDefaultModel()).toEqual({ model: "picked-model", provider: "openrouter" });
  });

  test("SERI_PROVIDER='bogus' falls back to DEFAULT_PROVIDER, does not throw", () => {
    process.env.SERI_PROVIDER = "bogus";
    expect(resolveDefaultModel()).toEqual({ model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER });
  });

  test("SERI_MODEL set with no SERI_PROVIDER: provider still defaults to groq", () => {
    process.env.SERI_MODEL = "env-model";
    expect(resolveDefaultModel()).toEqual({ model: "env-model", provider: "groq" });
  });
});

describe("persistDefaultModel", () => {
  test("writes both keys, readable back by a subsequent resolveDefaultModel", () => {
    persistDefaultModel({ model: "written-model", provider: "google" });
    expect(resolveDefaultModel()).toEqual({ model: "written-model", provider: "google" });
  });
});
