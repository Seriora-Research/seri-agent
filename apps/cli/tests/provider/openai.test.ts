import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOpenAIModel } from "../../src/provider/openai";

const originalKey = process.env.OPENAI_API_KEY;
const originalHome = process.env.HOME;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

let tmpRoot: string;

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;

  tmpRoot = mkdtempSync(join(tmpdir(), "seri-openai-test-"));
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  restoreEnv("OPENAI_API_KEY", originalKey);
  restoreEnv("HOME", originalHome);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getOpenAIModel", () => {
  test("throws a clear error when OPENAI_API_KEY is unset", () => {
    expect(() => getOpenAIModel("gpt-5")).toThrow(
      "OPENAI_API_KEY is not set. Set it as an environment variable and re-run.",
    );
  });

  test("returns a model object without a network call when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "fake-test-key";
    const model = getOpenAIModel("gpt-5");
    expect(model).toBeDefined();
  });
});
