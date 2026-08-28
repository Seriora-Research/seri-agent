import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskValue } from "../../src/config/commands";
import { loadConfig, setConfigValue } from "../../src/config/config";

describe("maskValue", () => {
  test("masks a long value keeping only the ends recognizable", () => {
    expect(maskValue("gsk_abcdefghijklmnop")).toBe("gsk_...mnop");
  });

  test("fully masks a short value rather than leaking most of it", () => {
    expect(maskValue("short")).toBe("*****");
  });
});

describe("setConfigValue", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-config-cmd-test-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test.skipIf(process.platform === "win32")(
    "tightens permissions on a pre-existing world-readable config",
    () => {
      const path = join(configDir, "config.json");
      writeFileSync(path, JSON.stringify({ EXISTING: "value" }), { mode: 0o644 });
      chmodSync(path, 0o644);

      setConfigValue("GROQ_API_KEY", "gsk_test_value", configDir);

      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  test("leaves no temp file behind", () => {
    setConfigValue("GROQ_API_KEY", "gsk_test_value", configDir);

    expect(readdirSync(configDir)).toEqual(["config.json"]);
    expect(loadConfig(configDir).GROQ_API_KEY).toBe("gsk_test_value");
  });
});
