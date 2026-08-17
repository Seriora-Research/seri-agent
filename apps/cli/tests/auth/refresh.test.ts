import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_FILENAME, loadAuthSession } from "../../src/auth/authStore";
import { refreshAccessToken, refreshSession } from "../../src/auth/refresh";

function fakeResponse(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, text: async () => JSON.stringify(body) } as Response;
}

describe("refreshAccessToken", () => {
  test("posts form-encoded grant_type=refresh_token with the refresh token and client id", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchFn = async (url: string, init: RequestInit) => {
      captured = { url, init };
      return fakeResponse(true, 200, {
        access_token: "at-new",
        refresh_token: "rt-new",
        expires_in: 300,
      });
    };

    const result = await refreshAccessToken(
      "client_123",
      "rt-old",
      fetchFn as unknown as typeof fetch,
    );

    expect(result).toEqual({
      status: "success",
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresIn: 300,
    });
    expect(captured?.url).toBe("https://api.workos.com/user_management/authenticate");
    expect(captured?.init.method).toBe("POST");
    expect(captured?.init.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(captured?.init.body).toBe(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "rt-old",
        client_id: "client_123",
      }).toString(),
    );
  });

  test("a non-200 response returns {status: 'error'} without throwing", async () => {
    const fetchFn = async () => fakeResponse(false, 400, { error: "invalid_grant" });

    const result = await refreshAccessToken(
      "client_123",
      "rt-old",
      fetchFn as unknown as typeof fetch,
    );

    expect(result.status).toBe("error");
  });

  // gateway.ts's authedFetch falls back to the original 401 response when refreshAccessToken
  // does not succeed — a thrown network error (offline, DNS failure) must reach that same
  // fallback, not replace the 401 with an uncaught rejection.
  test("a fetchFn rejection (offline, DNS failure) returns {status: 'error'} without throwing", async () => {
    const fetchFn = async () => {
      throw new Error("fetch failed");
    };

    const result = await refreshAccessToken(
      "client_123",
      "rt-old",
      fetchFn as unknown as typeof fetch,
    );

    expect(result.status).toBe("error");
  });

  // A 200 with a malformed body must not persist undefined tokens.
  test("a 200 response missing token fields returns {status: 'error'}", async () => {
    const fetchFn = async () => fakeResponse(true, 200, { expires_in: 300 });

    const result = await refreshAccessToken(
      "client_123",
      "rt-old",
      fetchFn as unknown as typeof fetch,
    );

    expect(result.status).toBe("error");
  });
});

describe("refreshSession", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-refresh-test-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function seedAuthJson(session: Record<string, unknown>): void {
    writeFileSync(join(configDir, AUTH_FILENAME), JSON.stringify(session));
  }

  // The rotation assertion: WorkOS rotates refresh tokens on every use, so persisting only the
  // access token is the classic bug this catches.
  test("on success, persists the rotated refresh token and a recomputed expiresAt", async () => {
    seedAuthJson({
      accessToken: "at-old",
      refreshToken: "rt-old",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
    });
    const fetchFn = async () =>
      fakeResponse(true, 200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 300 });

    const updated = await refreshSession(configDir, fetchFn as unknown as typeof fetch);

    expect(updated?.accessToken).toBe("at-new");
    expect(updated?.refreshToken).toBe("rt-new");
    expect(updated?.expiresAt).not.toBe("2026-01-01T00:05:00.000Z");

    const onDisk = loadAuthSession(configDir);
    expect(onDisk?.accessToken).toBe("at-new");
    expect(onDisk?.refreshToken).toBe("rt-new");
  });

  test("non-200 returns undefined, no write, no throw", async () => {
    seedAuthJson({
      accessToken: "at-old",
      refreshToken: "rt-old",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
    });
    const fetchFn = async () => fakeResponse(false, 400, { error: "invalid_grant" });

    const updated = await refreshSession(configDir, fetchFn as unknown as typeof fetch);

    expect(updated).toBeUndefined();
    expect(loadAuthSession(configDir)?.accessToken).toBe("at-old");
  });

  test("a malformed 200 response leaves the stored session untouched", async () => {
    seedAuthJson({
      accessToken: "at-old",
      refreshToken: "rt-old",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
    });
    const fetchFn = async () => fakeResponse(true, 200, { expires_in: 300 });

    const updated = await refreshSession(configDir, fetchFn as unknown as typeof fetch);

    expect(updated).toBeUndefined();
    expect(loadAuthSession(configDir)?.accessToken).toBe("at-old");
  });

  // Back-compat for every session already on disk: authStore.ts's expiresAt is optional and
  // additive, and a pre-existing auth.json written before this feature has no such field.
  test("a pre-existing auth.json with no expiresAt field still parses and refreshes", async () => {
    seedAuthJson({
      accessToken: "at-old",
      refreshToken: "rt-old",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
    });
    const fetchFn = async () =>
      fakeResponse(true, 200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 300 });

    const updated = await refreshSession(configDir, fetchFn as unknown as typeof fetch);

    expect(updated?.accessToken).toBe("at-new");
  });
});
