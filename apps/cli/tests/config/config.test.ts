import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir, setProfileOverride } from "../../src/config/paths";
import {
  CONFIG_FILENAME,
  getApiKey,
  inspectConfig,
  loadConfig,
  loadTrajectoryConfig,
  loadVerifyConfig,
  setConfigValue,
  setConfigValues,
  tuiBackgroundColor,
} from "../../src/config/config";

const originalHome = process.env.HOME;

let tmpRoot: string;
let configDir: string;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-config-test-"));
  process.env.HOME = tmpRoot;
  configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  // This file's own guard, not borrowed from paths.test.ts/argv.test.ts's cleanup: getConfigDir()
  // here is profile-aware, so a leaked override would resolve the wrong directory with nothing in
  // this file catching it.
  setProfileOverride(undefined);
  restoreEnv("HOME", originalHome);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("returns {} when config.json does not exist", () => {
    expect(loadConfig()).toEqual({});
  });

  test("returns {} when config.json is empty", () => {
    writeFileSync(join(configDir, CONFIG_FILENAME), "");
    expect(loadConfig()).toEqual({});
  });

  // Bun's JSON.parse of `\0` prints `Unrecognized token ''` — the quotes look empty
  // because the token is invisible. That is the Windows `--profile staging` crash.
  test("returns {} when config.json is a NUL byte", () => {
    writeFileSync(join(configDir, CONFIG_FILENAME), Buffer.from([0x00]));
    expect(loadConfig()).toEqual({});
  });

  test("returns {} when config.json is malformed UTF-8 JSON", () => {
    writeFileSync(join(configDir, CONFIG_FILENAME), "{not valid json");
    expect(loadConfig()).toEqual({});
  });

  test("reads a UTF-16 LE config.json the way Windows editors write one", () => {
    writeFileSync(
      join(configDir, CONFIG_FILENAME),
      Buffer.from(`\uFEFF${JSON.stringify({ GROQ_API_KEY: "gsk_from_notepad" })}`, "utf16le"),
    );
    expect(loadConfig()).toEqual({ GROQ_API_KEY: "gsk_from_notepad" });
  });
});

describe("inspectConfig", () => {
  test("names missing, unlike loadConfig which returns {}", () => {
    expect(inspectConfig()).toEqual({ status: "missing" });
    expect(loadConfig()).toEqual({});
  });

  test("names unreadable JSON that loadConfig still swallows", () => {
    writeFileSync(join(configDir, CONFIG_FILENAME), "{not valid json");
    expect(inspectConfig()).toEqual({ status: "malformed", reason: "unreadable" });
    expect(loadConfig()).toEqual({});
  });

  test("names a JSON array that loadConfig still swallows", () => {
    writeFileSync(join(configDir, CONFIG_FILENAME), "[]");
    expect(inspectConfig()).toEqual({ status: "malformed", reason: "not-object" });
    expect(loadConfig()).toEqual({});
  });
});

describe("setConfigValues", () => {
  // code-review finding on PR #71: two independent setConfigValue calls for a logically-paired
  // update (persistDefaultModel's own former shape) can land only one of the two keys if
  // interrupted between them. setConfigValues exists to make that impossible by construction —
  // one loadConfig/writeConfig pair for the whole batch.
  test("writes multiple keys in a single call", () => {
    setConfigValues({ SERI_MODEL: "picked-model", SERI_PROVIDER: "openrouter" });
    expect(loadConfig()).toEqual({ SERI_MODEL: "picked-model", SERI_PROVIDER: "openrouter" });
  });

  test("merges with existing keys rather than replacing the whole file", () => {
    setConfigValue("GROQ_API_KEY", "existing-key", configDir);
    setConfigValues({ SERI_MODEL: "picked-model", SERI_PROVIDER: "openrouter" });
    expect(loadConfig()).toEqual({
      GROQ_API_KEY: "existing-key",
      SERI_MODEL: "picked-model",
      SERI_PROVIDER: "openrouter",
    });
  });

  // The atomicity proof itself: writeConfig's own write-then-rename path (atomicWriteFile.ts) now
  // uses a randomized tmp filename (that module's own comment explains why — a fixed name raced
  // between two concurrent writers), so it can no longer be pre-created and collided with
  // directly by name. Sabotages the RENAME step instead, via two platform-specific mechanisms
  // combined, since neither alone is portable: POSIX's rename(2) checks write permission on the
  // PARENT DIRECTORY, never the target file's own permissions, so chmod on the directory blocks
  // it there; Windows instead honors the target FILE's own read-only attribute for a rename-over,
  // and (matching this repo's own chmod-on-a-directory-is-a-no-op-on-Windows precedent,
  // config/commands.test.ts) chmod on the directory alone does nothing there — verified
  // empirically: directory-only chmod let the rename through on this repo's own Windows dev box,
  // and the combination of both reliably blocks it. There is no "partially written" state to
  // observe here because there is only ONE write attempt for the whole batch — this is what a
  // caller updating several keys together actually needs, and what two independent
  // setConfigValue calls cannot give: neither key changes when the single write fails, not
  // "whichever call ran first still landed."
  test("a sabotaged write leaves every key unchanged — one atomic write, not several", () => {
    const path = join(configDir, "config.json");
    writeFileSync(path, JSON.stringify({ SERI_MODEL: "old-model" }));
    chmodSync(configDir, 0o555);
    chmodSync(path, 0o444);

    try {
      expect(() =>
        setConfigValues({ SERI_MODEL: "new-model", SERI_PROVIDER: "openrouter" }),
      ).toThrow();

      expect(loadConfig()).toEqual({ SERI_MODEL: "old-model" });
    } finally {
      // Restored so afterEach's rmSync(tmpRoot, ...) can actually delete it.
      chmodSync(configDir, 0o755);
      chmodSync(path, 0o644);
    }
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
    delete process.env.SERI_VERIFY_COMMAND;
  });

  // The default for every user: on, but with nothing to run, so nothing is ever spawned.
  test("enabled with no command when nothing is configured", () => {
    expect(loadVerifyConfig()).toEqual({ enabled: true, command: undefined });
  });

  test("reads the command from config.json, and lets the environment override it", () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ SERI_VERIFY_COMMAND: "bun run typecheck" }),
    );
    expect(loadVerifyConfig().command).toBe("bun run typecheck");

    process.env.SERI_VERIFY_COMMAND = "tsc --noEmit";
    expect(loadVerifyConfig().command).toBe("tsc --noEmit");
  });

  test('turns off on exactly "false", from config.json or from the environment', () => {
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
});

describe("loadTrajectoryConfig", () => {
  const originalEnabled = process.env.SERI_TRAJECTORY_ENABLED;
  const originalDays = process.env.SERI_TRAJECTORY_RETENTION_DAYS;

  afterEach(() => {
    restoreEnv("SERI_TRAJECTORY_ENABLED", originalEnabled);
    restoreEnv("SERI_TRAJECTORY_RETENTION_DAYS", originalDays);
  });

  test("enabled with a 30-day window when nothing is configured", () => {
    delete process.env.SERI_TRAJECTORY_ENABLED;
    delete process.env.SERI_TRAJECTORY_RETENTION_DAYS;
    expect(loadTrajectoryConfig()).toEqual({ enabled: true, retentionDays: 30 });
  });

  test('turns off on exactly "false"', () => {
    delete process.env.SERI_TRAJECTORY_ENABLED;
    process.env.SERI_TRAJECTORY_ENABLED = "false";
    expect(loadTrajectoryConfig().enabled).toBe(false);
  });

  test("non-positive or unparseable retention days fall back to 30", () => {
    delete process.env.SERI_TRAJECTORY_RETENTION_DAYS;
    process.env.SERI_TRAJECTORY_RETENTION_DAYS = "0";
    expect(loadTrajectoryConfig().retentionDays).toBe(30);
    process.env.SERI_TRAJECTORY_RETENTION_DAYS = "nope";
    expect(loadTrajectoryConfig().retentionDays).toBe(30);
  });

  test("parses exponent-form retention days as the full integer, not parseInt's prefix", () => {
    delete process.env.SERI_TRAJECTORY_RETENTION_DAYS;
    process.env.SERI_TRAJECTORY_RETENTION_DAYS = "1e3";
    expect(loadTrajectoryConfig().retentionDays).toBe(1000);
  });
});

describe("tuiBackgroundColor", () => {
  test("returns a #rrggbb value, in either case", () => {
    expect(tuiBackgroundColor("#141413")).toBe("#141413");
    expect(tuiBackgroundColor("#AABBCC")).toBe("#AABBCC");
  });

  // Every one of these means "leave the terminal's own ground alone" — the documented `terminal`
  // spelling and a typo behave identically on purpose, because this is read while the renderer is
  // being built and has no way to report an error.
  test.each([
    ["the documented off switch", "terminal"],
    ["empty", ""],
    ["unset", undefined],
    ["too short", "#12345"],
    ["a named color", "red"],
    ["hex with no #", "141413"],
  ])("returns undefined for %s", (_label, value) => {
    expect(tuiBackgroundColor(value)).toBeUndefined();
  });
});
