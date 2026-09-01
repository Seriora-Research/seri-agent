import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigValue } from "../../src/config/config";
import { getConfigDir } from "../../src/config/paths";
import {
  loadSamplingConfig,
  parseOpenRouterPin,
  parseSeed,
  parseTemperature,
  resolveSampling,
  seedSupport,
  temperatureSupport,
} from "../../src/provider/sampling";

const originalHome = process.env.HOME;
const originalTemp = process.env.SERI_TEMPERATURE;
const originalSeed = process.env.SERI_SEED;
const originalPin = process.env.SERI_OPENROUTER_PROVIDER;

function restore(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-sampling-"));
  process.env.HOME = tmpRoot;
  delete process.env.SERI_TEMPERATURE;
  delete process.env.SERI_SEED;
  delete process.env.SERI_OPENROUTER_PROVIDER;
  mkdirSync(getConfigDir(), { recursive: true });
});

afterEach(() => {
  restore("HOME", originalHome);
  restore("SERI_TEMPERATURE", originalTemp);
  restore("SERI_SEED", originalSeed);
  restore("SERI_OPENROUTER_PROVIDER", originalPin);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("parseTemperature / parseSeed / parseOpenRouterPin", () => {
  test("accepts a finite temperature including 0", () => {
    expect(parseTemperature("0")).toBe(0);
    expect(parseTemperature("0.2")).toBe(0.2);
    expect(parseTemperature("nope")).toBeUndefined();
    expect(parseTemperature(undefined)).toBeUndefined();
  });

  test("accepts a safe integer seed and rejects fractions", () => {
    expect(parseSeed("42")).toBe(42);
    expect(parseSeed("0")).toBe(0);
    expect(parseSeed("1.5")).toBeUndefined();
    expect(parseSeed("nope")).toBeUndefined();
  });

  test("splits a comma pin and drops empties", () => {
    expect(parseOpenRouterPin("Anthropic")).toEqual(["Anthropic"]);
    expect(parseOpenRouterPin("Anthropic, OpenAI")).toEqual(["Anthropic", "OpenAI"]);
    expect(parseOpenRouterPin("  ,  ")).toBeUndefined();
    expect(parseOpenRouterPin(undefined)).toBeUndefined();
  });
});

describe("capability matrix", () => {
  test("subscriptions reject both knobs — Codex is known to 400 on temperature", () => {
    expect(temperatureSupport("openai", "subscription")).toBe("unsupported");
    expect(seedSupport("openai", "subscription")).toBe("unsupported");
    expect(temperatureSupport("xai", "subscription")).toBe("unsupported");
    expect(seedSupport("xai", "subscription")).toBe("unsupported");
  });

  test("Anthropic and OpenAI key paths have no seed", () => {
    expect(temperatureSupport("anthropic", "key")).toBe("supported");
    expect(seedSupport("anthropic", "key")).toBe("unsupported");
    expect(temperatureSupport("openai", "key")).toBe("supported");
    expect(seedSupport("openai", "key")).toBe("unsupported");
  });

  test("Groq, OpenRouter, Google, xAI key, and gateway accept both", () => {
    for (const provider of ["groq", "openrouter", "google", "xai"] as const) {
      expect(temperatureSupport(provider, "key")).toBe("supported");
      expect(seedSupport(provider, "key")).toBe("supported");
    }
    expect(temperatureSupport("openai", "gateway")).toBe("supported");
    expect(seedSupport("openai", "gateway")).toBe("supported");
  });

  test("resolveSampling records unsupported rather than omitting, and does not send", () => {
    const resolved = resolveSampling("openai", "subscription", { temperature: 0, seed: 7 });
    expect(resolved.temperature).toBeUndefined();
    expect(resolved.seed).toBeUndefined();
    expect(resolved.temperatureRecord).toBe("unsupported");
    expect(resolved.seedRecord).toBe("unsupported");
  });

  test("resolveSampling records null when supported and unset", () => {
    const resolved = resolveSampling("groq", "key", {});
    expect(resolved.temperatureRecord).toBeNull();
    expect(resolved.seedRecord).toBeNull();
    expect(resolved.temperature).toBeUndefined();
    expect(resolved.seed).toBeUndefined();
  });
});

describe("loadSamplingConfig", () => {
  test("env wins over config.json", () => {
    setConfigValue("SERI_TEMPERATURE", "0.9", getConfigDir());
    process.env.SERI_TEMPERATURE = "0";
    expect(loadSamplingConfig(getConfigDir()).temperature).toBe(0);
  });

  test("unset env and file yields undefined", () => {
    expect(loadSamplingConfig(getConfigDir())).toEqual({
      temperature: undefined,
      seed: undefined,
      openRouterPin: undefined,
    });
  });
});
