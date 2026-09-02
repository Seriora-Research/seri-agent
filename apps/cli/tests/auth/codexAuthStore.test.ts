import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCodexSubscription,
  CODEX_SERI_AUTH_FILENAME,
  codexHome,
  hasCodexSubscription,
  jwtExpiryMs,
  loadCodexAuth,
  loadCodexSubscription,
  loadUsableCodexGrant,
  readCodexAuthMode,
  saveCodexSubscription,
} from "../../src/auth/codexAuthStore";

function chatgptAuth(overrides: Record<string, unknown> = {}) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: "id",
      access_token: "access-1",
      refresh_token: "refresh-1",
      account_id: "acct-1",
    },
    last_refresh: "2026-08-31T23:43:21Z",
    ...overrides,
  };
}

describe("codexAuthStore", () => {
  let home: string;
  const original = process.env.CODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seri-codex-auth-"));
    process.env.CODEX_HOME = home;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  test("a chatgpt login with an access token is a connected subscription", () => {
    writeFileSync(join(home, "auth.json"), JSON.stringify(chatgptAuth()));
    expect(hasCodexSubscription()).toBe(true);
    expect(loadCodexAuth()?.accountId).toBe("acct-1");
    expect(loadCodexAuth()?.accessToken).toBe("access-1");
  });

  test("an API-key login is not a ChatGPT subscription", () => {
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }),
    );
    expect(hasCodexSubscription()).toBe(false);
    expect(loadCodexAuth()).toBeUndefined();
    expect(readCodexAuthMode()).toBe("apikey");
  });

  test("a missing file is not connected", () => {
    expect(hasCodexSubscription()).toBe(false);
    expect(loadCodexAuth()).toBeUndefined();
  });

  test("a malformed file is not connected rather than throwing", () => {
    writeFileSync(join(home, "auth.json"), "{ not json");
    expect(loadCodexAuth()).toBeUndefined();
    expect(hasCodexSubscription()).toBe(false);
  });

  test("a chatgpt file missing the access token is not connected", () => {
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "acct-1" } }),
    );
    expect(loadCodexAuth()).toBeUndefined();
  });
});

describe("codexHome", () => {
  test("CODEX_HOME wins on every platform", () => {
    expect(codexHome({ CODEX_HOME: "/tmp/codex-override" }, "win32")).toBe("/tmp/codex-override");
    expect(codexHome({ CODEX_HOME: "/tmp/codex-override" }, "linux")).toBe("/tmp/codex-override");
  });

  test("win32 ignores HOME and uses USERPROFILE", () => {
    expect(
      codexHome({ HOME: "/c/Users/dest", USERPROFILE: "C:\\Users\\dest" }, "win32"),
    ).toBe(join("C:\\Users\\dest", ".codex"));
    expect(
      codexHome({ HOME: "/home/user", USERPROFILE: "C:\\Users\\dest" }, "win32"),
    ).toBe(join("C:\\Users\\dest", ".codex"));
  });

  test("posix uses HOME", () => {
    expect(codexHome({ HOME: "/home/dest" }, "linux")).toBe(join("/home/dest", ".codex"));
  });
});

describe("seri-owned Codex store", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-codex-seri-auth-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("save and load round-trip", () => {
    saveCodexSubscription(
      {
        accessToken: "a",
        refreshToken: "r",
        obtainedAt: "2026-01-01T00:00:00.000Z",
        accountId: "acct-9",
      },
      configDir,
    );
    expect(loadCodexSubscription(configDir)?.accountId).toBe("acct-9");
    expect(hasCodexSubscription(configDir)).toBe(true);
    expect(loadUsableCodexGrant(configDir)?.source).toBe("seri");
  });

  test("clear unlinks only the seri file", () => {
    saveCodexSubscription(
      {
        accessToken: "a",
        refreshToken: "r",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      },
      configDir,
    );
    clearCodexSubscription(configDir);
    expect(loadCodexSubscription(configDir)).toBeUndefined();
    expect(existsSync(join(configDir, CODEX_SERI_AUTH_FILENAME))).toBe(false);
  });
});

describe("jwtExpiryMs", () => {
  test("reads exp from an unsigned JWT payload", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString("base64url");
    expect(jwtExpiryMs(`aaa.${payload}.sig`)).toBe(1_700_000_000_000);
  });

  test("a non-JWT returns 0 rather than throwing", () => {
    expect(jwtExpiryMs("not-a-jwt")).toBe(0);
  });
});
