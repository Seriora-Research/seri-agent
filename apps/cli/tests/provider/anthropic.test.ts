import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAnthropicModel } from "../../src/provider/anthropic";

const originalKey = process.env.ANTHROPIC_API_KEY;
const originalHome = process.env.HOME;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

let tmpRoot: string;

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;

  tmpRoot = mkdtempSync(join(tmpdir(), "seri-anthropic-test-"));
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  restoreEnv("ANTHROPIC_API_KEY", originalKey);
  restoreEnv("HOME", originalHome);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getAnthropicModel", () => {
  test("throws a clear error when ANTHROPIC_API_KEY is unset", () => {
    expect(() => getAnthropicModel("claude-sonnet-4-5")).toThrow(
      "ANTHROPIC_API_KEY is not set. Set it as an environment variable and re-run.",
    );
  });

  test("returns a model object without a network call when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "fake-test-key";
    const model = getAnthropicModel("claude-sonnet-4-5");
    expect(model).toBeDefined();
  });
});
