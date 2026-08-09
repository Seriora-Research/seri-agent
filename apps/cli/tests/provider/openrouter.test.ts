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
    expect(() => getOpenRouterModel("openai/gpt-oss-120b")).toThrow(
      "OPENROUTER_API_KEY is not set. Run: seri config set OPENROUTER_API_KEY <your-key>",
    );
  });

  test("returns a model object without a network call when OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "fake-test-key";
    const model = getOpenRouterModel("openai/gpt-oss-120b");
    expect(model).toBeDefined();
  });
});
