import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasCodexSubscription,
  jwtExpiryMs,
  loadCodexAuth,
  readCodexAuthMode,
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

describe("jwtExpiryMs", () => {
  test("reads exp from an unsigned JWT payload", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString("base64url");
    expect(jwtExpiryMs(`aaa.${payload}.sig`)).toBe(1_700_000_000_000);
  });

  test("a non-JWT returns 0 rather than throwing", () => {
    expect(jwtExpiryMs("not-a-jwt")).toBe(0);
  });
});
