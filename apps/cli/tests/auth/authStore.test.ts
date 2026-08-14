import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_FILENAME,
  type AuthSession,
  clearAuthSession,
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
