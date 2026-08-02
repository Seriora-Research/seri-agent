import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGroqModel } from "../../src/provider/groq";

const originalKey = process.env.GROQ_API_KEY;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalHome = process.env.HOME;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

let tmpRoot: string;

beforeEach(() => {
  delete process.env.GROQ_API_KEY;
  // Point the config dir at an empty temp dir so a real config.json on this
  // machine can never supply GROQ_API_KEY and mask the "unset" case.
  tmpRoot = mkdtempSync(join(tmpdir(), "hesper-groq-test-"));
  if (process.platform === "win32") process.env.LOCALAPPDATA = tmpRoot;
  else process.env.HOME = tmpRoot;
});

afterEach(() => {
  restoreEnv("GROQ_API_KEY", originalKey);
  restoreEnv("LOCALAPPDATA", originalLocalAppData);
  restoreEnv("HOME", originalHome);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getGroqModel", () => {
  test("throws a clear error when GROQ_API_KEY is unset", () => {
    expect(() => getGroqModel()).toThrow("GROQ_API_KEY is not set (env var or config file)");
  });

  test("returns a model object without a network call when GROQ_API_KEY is set", () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const model = getGroqModel();
    expect(model).toBeDefined();
  });
});
