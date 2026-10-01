import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVercelModel } from "../../src/provider/vercel";

const originalKey = process.env.AI_GATEWAY_API_KEY;
const originalHome = process.env.HOME;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

let tmpRoot: string;

beforeEach(() => {
  delete process.env.AI_GATEWAY_API_KEY;

  tmpRoot = mkdtempSync(join(tmpdir(), "seri-vercel-test-"));
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  restoreEnv("AI_GATEWAY_API_KEY", originalKey);
  restoreEnv("HOME", originalHome);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getVercelModel", () => {
  test("throws a clear error when AI_GATEWAY_API_KEY is unset", () => {
    expect(() => getVercelModel("openai/gpt-4.1-mini")).toThrow(
      "AI_GATEWAY_API_KEY is not set. Set it as an environment variable and re-run.",
    );
  });

  test("returns a model object without a network call when AI_GATEWAY_API_KEY is set", () => {
    process.env.AI_GATEWAY_API_KEY = "fake-test-key";
    const model = getVercelModel("openai/gpt-4.1-mini");
    expect(model).toBeDefined();
  });
});
