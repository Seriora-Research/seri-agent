import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../src/config/paths";
import { getApiKey, loadConfig } from "../../src/config/config";

const originalLocalAppData = process.env.LOCALAPPDATA;
const originalHome = process.env.HOME;

let tmpRoot: string;
let configDir: string;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-config-test-"));
  if (process.platform === "win32") process.env.LOCALAPPDATA = tmpRoot;
  else process.env.HOME = tmpRoot;
  configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  restoreEnv("LOCALAPPDATA", originalLocalAppData);
  restoreEnv("HOME", originalHome);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("returns {} when config.json does not exist", () => {
    expect(loadConfig()).toEqual({});
  });
});

describe("getApiKey", () => {
  const KEY = "SERI_TEST_API_KEY";

  afterEach(() => {
    delete process.env[KEY];
  });

  test("env var wins when both env and config define the same key", () => {
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ [KEY]: "from-config" }));
    process.env[KEY] = "from-env";
    expect(getApiKey(KEY)).toBe("from-env");
  });

  test("falls back to config when env is unset", () => {
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ [KEY]: "from-config" }));
    delete process.env[KEY];
    expect(getApiKey(KEY)).toBe("from-config");
  });

  test("undefined when neither env nor config define the key", () => {
    delete process.env[KEY];
    expect(getApiKey(KEY)).toBeUndefined();
  });
});
