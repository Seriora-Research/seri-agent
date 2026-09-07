import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOpenRouterModel } from "../../src/provider/openrouter";

const originalKey = process.env.OPENROUTER_API_KEY;
const originalHome = process.env.HOME;
const originalPin = process.env.SERI_OPENROUTER_PROVIDER;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

let tmpRoot: string;

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SERI_OPENROUTER_PROVIDER;

  tmpRoot = mkdtempSync(join(tmpdir(), "seri-openrouter-test-"));
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  restoreEnv("OPENROUTER_API_KEY", originalKey);
  restoreEnv("HOME", originalHome);
  restoreEnv("SERI_OPENROUTER_PROVIDER", originalPin);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getOpenRouterModel", () => {
  test("throws a clear error when OPENROUTER_API_KEY is unset", () => {
    expect(() => getOpenRouterModel("openai/gpt-oss-120b", "test-session-id")).toThrow(
      "OPENROUTER_API_KEY is not set. Set it as an environment variable and re-run.",
    );
  });

  test("returns a model object without a network call when OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "fake-test-key";
    const model = getOpenRouterModel("openai/gpt-oss-120b", "test-session-id");
    expect(model).toBeDefined();
  });

  test("passes session_id through to the request's extraBody", () => {
    process.env.OPENROUTER_API_KEY = "fake-test-key";
    const model = getOpenRouterModel("openai/gpt-oss-120b", "my-session-id") as unknown as {
      settings: { extraBody?: Record<string, unknown> };
    };
    expect(model.settings.extraBody).toEqual({ session_id: "my-session-id" });
  });

  test("a pin sets provider.order and drops session_id", () => {
    process.env.OPENROUTER_API_KEY = "fake-test-key";
    process.env.SERI_OPENROUTER_PROVIDER = "Anthropic,OpenAI";
    const model = getOpenRouterModel("openai/gpt-oss-120b", "my-session-id") as unknown as {
      settings: { extraBody?: Record<string, unknown> };
    };
    expect(model.settings.extraBody).toEqual({
      provider: { order: ["Anthropic", "OpenAI"], allow_fallbacks: false },
    });
    expect(model.settings.extraBody).not.toHaveProperty("session_id");
  });
});
