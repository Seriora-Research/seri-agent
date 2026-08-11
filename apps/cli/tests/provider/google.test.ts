import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGoogleModel } from "../../src/provider/google";

const originalKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const originalHome = process.env.HOME;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

let tmpRoot: string;

beforeEach(() => {
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  // Point the config dir at an empty temp dir so a real config.json on this
  // machine can never supply GOOGLE_GENERATIVE_AI_API_KEY and mask the "unset" case.
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-google-test-"));
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  restoreEnv("GOOGLE_GENERATIVE_AI_API_KEY", originalKey);
  restoreEnv("HOME", originalHome);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getGoogleModel", () => {
  test("throws a clear error when GOOGLE_GENERATIVE_AI_API_KEY is unset", () => {
    expect(() => getGoogleModel("gemini-2.5-pro")).toThrow(
      "GOOGLE_GENERATIVE_AI_API_KEY is not set. Run: seri config set GOOGLE_GENERATIVE_AI_API_KEY <your-key>",
    );
  });

  test("returns a model object without a network call when GOOGLE_GENERATIVE_AI_API_KEY is set", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "fake-test-key";
    const model = getGoogleModel("gemini-2.5-pro");
    expect(model).toBeDefined();
  });
});
