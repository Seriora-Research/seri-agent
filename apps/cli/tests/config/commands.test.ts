import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configCommand, maskValue } from "../../src/config/commands";
import { loadConfig, setConfigValue } from "../../src/config/config";

describe("maskValue", () => {
  test("masks a long value keeping only the ends recognizable", () => {
    expect(maskValue("gsk_abcdefghijklmnop")).toBe("gsk_...mnop");
  });

  test("fully masks a short value rather than leaking most of it", () => {
    expect(maskValue("short")).toBe("*****");
  });
});

describe("configCommand", () => {
  let configDir: string;
  let logs: string[];
  let errors: string[];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "hesper-config-cmd-test-"));
    logs = [];
    errors = [];
    console.log = (msg: string) => logs.push(String(msg));
    console.error = (msg: string) => errors.push(String(msg));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("set writes the value to config.json", () => {
    const code = configCommand(["set", "GROQ_API_KEY", "gsk_test_value"], configDir);

    expect(code).toBe(0);
    expect(loadConfig(configDir).GROQ_API_KEY).toBe("gsk_test_value");
  });

  test("set preserves other existing keys", () => {
    setConfigValue("EXISTING", "kept", configDir);

    configCommand(["set", "GROQ_API_KEY", "gsk_test_value"], configDir);

    expect(loadConfig(configDir)).toEqual({ EXISTING: "kept", GROQ_API_KEY: "gsk_test_value" });
  });

  test("set without a value returns non-zero and writes nothing", () => {
    const code = configCommand(["set", "GROQ_API_KEY"], configDir);

    expect(code).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(loadConfig(configDir)).toEqual({});
  });

  test("list masks stored values instead of printing them in full", () => {
    setConfigValue("GROQ_API_KEY", "gsk_abcdefghijklmnop", configDir);

    const code = configCommand(["list"], configDir);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("gsk_...mnop");
    expect(logs.join("\n")).not.toContain("gsk_abcdefghijklmnop");
  });

  test("list on an empty config says so rather than printing nothing", () => {
    const code = configCommand(["list"], configDir);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("No values set");
  });

  test("unset removes an existing key", () => {
    setConfigValue("GROQ_API_KEY", "gsk_test_value", configDir);

    const code = configCommand(["unset", "GROQ_API_KEY"], configDir);

    expect(code).toBe(0);
    expect(loadConfig(configDir)).toEqual({});
    expect(logs.join("\n")).toContain("Removed");
  });

  test("unset reports when the key was never set", () => {
    const code = configCommand(["unset", "NOT_THERE"], configDir);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("was not set");
  });

  test("an unknown subcommand prints usage and returns non-zero", () => {
    const code = configCommand(["bogus"], configDir);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Usage:");
  });
});
