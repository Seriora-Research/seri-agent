import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigValue } from "../../src/config/config";
import { DEFAULT_MODEL, getGroqModel, resolveModelId } from "../../src/provider/groq";

const originalKey = process.env.GROQ_API_KEY;
const originalModel = process.env.SERI_MODEL;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalHome = process.env.HOME;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

let tmpRoot: string;

beforeEach(() => {
  delete process.env.GROQ_API_KEY;
  delete process.env.SERI_MODEL;
  // Point the config dir at an empty temp dir so a real config.json on this
  // machine can never supply GROQ_API_KEY and mask the "unset" case.
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-groq-test-"));
  if (process.platform === "win32") process.env.LOCALAPPDATA = tmpRoot;
  else process.env.HOME = tmpRoot;
});

afterEach(() => {
  restoreEnv("GROQ_API_KEY", originalKey);
  restoreEnv("SERI_MODEL", originalModel);
  restoreEnv("LOCALAPPDATA", originalLocalAppData);
  restoreEnv("HOME", originalHome);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getGroqModel", () => {
  test("throws a clear error when GROQ_API_KEY is unset", () => {
    expect(() => getGroqModel()).toThrow("GROQ_API_KEY is not set. Run: seri config set GROQ_API_KEY <your-key>");
  });

  test("returns a model object without a network call when GROQ_API_KEY is set", () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const model = getGroqModel();
    expect(model).toBeDefined();
  });
});

describe("resolveModelId", () => {
  test("SERI_MODEL overrides the default, env taking precedence over config", () => {
    expect(resolveModelId()).toBe(DEFAULT_MODEL);

    setConfigValue("SERI_MODEL", "from-config");
    expect(resolveModelId()).toBe("from-config");

    process.env.SERI_MODEL = "from-env";
    expect(resolveModelId()).toBe("from-env");

    // Same as getApiKey: an env var set to the empty string is not a value, so it falls through
    // to the config file rather than winning and asking the provider for a model called "".
    process.env.SERI_MODEL = "";
    expect(resolveModelId()).toBe("from-config");
  });
});
