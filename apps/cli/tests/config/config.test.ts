import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../src/config/paths";
import { getApiKey, loadConfig, loadVerifyConfig } from "../../src/config/config";

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

describe("loadVerifyConfig", () => {
  afterEach(() => {
    delete process.env.SERI_VERIFY_ENABLED;
    delete process.env.SERI_VERIFY_TIMEOUT_MS;
  });

  test("enabled with no timeout override when nothing is configured", () => {
    expect(loadVerifyConfig()).toEqual({ enabled: true, timeoutMs: undefined });
  });

  test("turns off on exactly \"false\", from config.json or from the environment", () => {
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ SERI_VERIFY_ENABLED: "false" }));
    expect(loadVerifyConfig().enabled).toBe(false);

    writeFileSync(join(configDir, "config.json"), "{}");
    process.env.SERI_VERIFY_ENABLED = "false";
    expect(loadVerifyConfig().enabled).toBe(false);
  });

  test("any other value leaves it on, so a typo cannot silently disable the check", () => {
    process.env.SERI_VERIFY_ENABLED = "no";
    expect(loadVerifyConfig().enabled).toBe(true);
  });

  test("reads a positive timeout and ignores an unparseable or zero one", () => {
    process.env.SERI_VERIFY_TIMEOUT_MS = "45000";
    expect(loadVerifyConfig().timeoutMs).toBe(45000);

    process.env.SERI_VERIFY_TIMEOUT_MS = "soon";
    expect(loadVerifyConfig().timeoutMs).toBeUndefined();

    process.env.SERI_VERIFY_TIMEOUT_MS = "0";
    expect(loadVerifyConfig().timeoutMs).toBeUndefined();
  });
});
