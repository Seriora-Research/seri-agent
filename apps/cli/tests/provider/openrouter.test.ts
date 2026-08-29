import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOpenRouterModel } from "../../src/provider/openrouter";

const originalKey = process.env.OPENROUTER_API_KEY;
const originalHome = process.env.HOME;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

let tmpRoot: string;

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  // Point the config dir at an empty temp dir so a real config.json on this
  // machine can never supply OPENROUTER_API_KEY and mask the "unset" case.
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-openrouter-test-"));
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  restoreEnv("OPENROUTER_API_KEY", originalKey);
  restoreEnv("HOME", originalHome);
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

  // code-review finding (PR #69): the test above only checked the model was truthy, never that
  // `sessionId` actually reached `extraBody` — a dropped argument or a renamed key (`sessionId`
  // instead of `session_id`) would still pass it. `OpenRouterChatLanguageModel.settings` is a
  // real, `readonly` runtime property on the installed @openrouter/ai-sdk-provider@3.0.0 (its own
  // constructor stores exactly what's passed in) — `getOpenRouterModel`'s return type is the AI
  // SDK's generic `LanguageModel`, which doesn't expose it, so this asserts against the narrower
  // shape directly, same "asserted against the real installed type" idiom cost.ts already uses
  // for OpenRouter's provider metadata.
  test("passes session_id through to the request's extraBody", () => {
    process.env.OPENROUTER_API_KEY = "fake-test-key";
    const model = getOpenRouterModel("openai/gpt-oss-120b", "my-session-id") as unknown as {
      settings: { extraBody?: Record<string, unknown> };
    };
    expect(model.settings.extraBody).toEqual({ session_id: "my-session-id" });
  });
});
