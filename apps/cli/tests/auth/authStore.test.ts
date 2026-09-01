import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_FILENAME,
  type AuthSession,
  clearAuthSession,
  expiresAtFrom,
  hasHostedAuth,
  loadAuthSession,
  saveAuthSession,
} from "../../src/auth/authStore";

describe("authStore", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-authstore-test-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("save then load round-trips the exact AuthSession", () => {
    const session: AuthSession = {
      accessToken: "at-1",
      refreshToken: "rt-1",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-08-02T00:00:00.000Z",
    };

    saveAuthSession(session, configDir);

    expect(loadAuthSession(configDir)).toEqual(session);
  });

  test("loadAuthSession returns undefined when no auth.json exists", () => {
    expect(loadAuthSession(configDir)).toBeUndefined();
  });

  // Thermo-nuclear review + code-review, PR #94: this file's own deliberate exception to
  // loadConfig's (config/config.ts) "let it throw, every caller wraps its own try/catch"
  // convention — a corrupted auth.json degrades to the exact same "not authenticated" state as no
  // file at all, in the one place that reads it, rather than a fourth call site somewhere
  // upstream needing its own guard against this exact throw.
  test("loadAuthSession returns undefined, not a throw, when auth.json is corrupted", () => {
    writeFileSync(join(configDir, AUTH_FILENAME), "{not valid json");

    expect(loadAuthSession(configDir)).toBeUndefined();
  });

  test("hasHostedAuth is true only for a session that actually has an access token", () => {
    expect(hasHostedAuth(configDir)).toBe(false);
    writeFileSync(
      join(configDir, AUTH_FILENAME),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "tok" } }),
    );
    expect(hasHostedAuth(configDir)).toBe(false);
    saveAuthSession(
      {
        accessToken: "at-1",
        refreshToken: "rt-1",
        userId: "user_1",
        email: "a@example.com",
        obtainedAt: "2026-08-02T00:00:00.000Z",
      },
      configDir,
    );
    expect(hasHostedAuth(configDir)).toBe(true);
  });

  test("clearAuthSession on a fresh dir with no session is a no-op", () => {
    expect(() => clearAuthSession(configDir)).not.toThrow();
  });

  test("clearAuthSession removes an existing session", () => {
    const session: AuthSession = {
      accessToken: "at-1",
      refreshToken: "rt-1",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-08-02T00:00:00.000Z",
    };
    saveAuthSession(session, configDir);

    clearAuthSession(configDir);

    expect(loadAuthSession(configDir)).toBeUndefined();
  });
});

describe("expiresAtFrom", () => {
  test("undefined expiresIn returns undefined", () => {
    expect(expiresAtFrom(undefined)).toBeUndefined();
  });

  test("a non-finite expiresIn returns undefined", () => {
    expect(expiresAtFrom(Number.NaN)).toBeUndefined();
    expect(expiresAtFrom(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("a negative expiresIn returns undefined", () => {
    expect(expiresAtFrom(-1)).toBeUndefined();
  });

  test("a finite expiresIn returns a valid ISO timestamp in the future", () => {
    const before = Date.now();
    const result = expiresAtFrom(300);
    expect(result).toBeDefined();
    expect(new Date(result as string).getTime()).toBeGreaterThanOrEqual(before + 300 * 1000);
  });

  // Number.isFinite(expiresIn) alone does not guarantee Date.now() + expiresIn * 1000 stays
  // inside Date's representable range (~±273,790 years from the epoch) — a huge-but-finite
  // value produces an internally-invalid Date whose toISOString() would throw.
  test("a finite but out-of-Date-range expiresIn returns undefined instead of throwing", () => {
    expect(() => expiresAtFrom(1e300)).not.toThrow();
    expect(expiresAtFrom(1e300)).toBeUndefined();
  });
});
