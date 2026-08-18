import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  // WorkOS's real refresh-grant response carries no expires_in field (confirmed live for the
  // device-flow token response, same auth system) — this is the normal shape, not an error.
  test("a 200 response with tokens but missing expires_in still succeeds, with expiresIn undefined", async () => {
    const fetchFn = async () =>
      fakeResponse(true, 200, { access_token: "at-new", refresh_token: "rt-new" });

    const result = await refreshAccessToken(
      "client_123",
      "rt-old",
      fetchFn as unknown as typeof fetch,
    );

    expect(result).toEqual({ status: "success", accessToken: "at-new", refreshToken: "rt-new" });
  });

  // A connection drop while reading the body must not escape as an uncaught rejection — that
  // would propagate out of refreshSession and stop authedFetch from returning the original 401.
  test("a body-read rejection returns {status: 'error'} without throwing", async () => {
    const fetchFn = async () =>
      ({
        ok: true,
        status: 200,
        text: async () => Promise.reject(new Error("stream reset")),
      }) as unknown as Response;

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

  // The real-world WorkOS response shape: no expires_in at all. A stale expiresAt from the
  // previous session must be cleared, not kept — it would describe the old token — but this is
  // still a successful refresh, not an error.
  test("a response with no expires_in still succeeds, clearing any previous expiresAt", async () => {
    seedAuthJson({
      accessToken: "at-old",
      refreshToken: "rt-old",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
    });
    const fetchFn = async () =>
      fakeResponse(true, 200, { access_token: "at-new", refresh_token: "rt-new" });

    const updated = await refreshSession(configDir, fetchFn as unknown as typeof fetch);

    expect(updated?.accessToken).toBe("at-new");
    expect(updated?.refreshToken).toBe("rt-new");
    expect(updated?.expiresAt).toBeUndefined();

    const onDisk = loadAuthSession(configDir);
    expect(onDisk?.accessToken).toBe("at-new");
    expect(onDisk?.expiresAt).toBeUndefined();
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

  // The race this guards against: two 401 handlers both read the same on-disk rotating refresh
  // token before either submits it. Without sharing one in-flight promise, one call's fetch
  // would win at WorkOS and the other would receive {status: "error"}, stranding that caller on
  // its original 401 even though a valid rotated pair now exists on disk.
  test("concurrent calls for the same configDir share one refresh and both resolve to it", async () => {
    seedAuthJson({
      accessToken: "at-old",
      refreshToken: "rt-old",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
    });
    let fetchCalls = 0;
    const fetchFn = async () => {
      fetchCalls++;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return fakeResponse(true, 200, {
        access_token: "at-new",
        refresh_token: "rt-new",
        expires_in: 300,
      });
    };

    const [first, second] = await Promise.all([
      refreshSession(configDir, fetchFn as unknown as typeof fetch),
      refreshSession(configDir, fetchFn as unknown as typeof fetch),
    ]);

    expect(fetchCalls).toBe(1);
    expect(first?.accessToken).toBe("at-new");
    expect(second?.accessToken).toBe("at-new");
    expect(loadAuthSession(configDir)?.accessToken).toBe("at-new");
  });

  // Once the shared in-flight refresh has settled, the next call must not keep reusing its
  // (now-stale) result — it has to trigger a fresh refresh.
  test("a later call after the in-flight refresh settles triggers a new refresh", async () => {
    seedAuthJson({
      accessToken: "at-old",
      refreshToken: "rt-old",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
    });
    let fetchCalls = 0;
    const fetchFn = async () => {
      fetchCalls++;
      return fakeResponse(true, 200, {
        access_token: `at-${fetchCalls}`,
        refresh_token: `rt-${fetchCalls}`,
        expires_in: 300,
      });
    };

    await refreshSession(configDir, fetchFn as unknown as typeof fetch);
    await refreshSession(configDir, fetchFn as unknown as typeof fetch);

    expect(fetchCalls).toBe(2);
  });

  // saveAuthSession's writeFileSync can genuinely throw (a read-only config dir, disk full) —
  // the caller's own `await refreshSession(...)` rejection is expected and fine, but the
  // in-flight map's internal `promise.finally(() => ...)` creates a SEPARATE derived promise
  // that also rejects; left uncaught, that is a second, unrelated unhandled rejection on top of
  // the one the caller is already handling.
  test("a save failure rejects the caller without also emitting an unhandled rejection", async () => {
    seedAuthJson({
      accessToken: "at-old",
      refreshToken: "rt-old",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
    });
    const fetchFn = async () =>
      fakeResponse(true, 200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 300 });
    const authPath = join(configDir, AUTH_FILENAME);
    // POSIX: write permission is checked on the file itself for an overwrite. Windows: Node
    // honors the target file's own read-only attribute for a write — same combination
    // apps/cli/tests/config/config.test.ts's own sabotaged-write test already verified works on
    // both platforms.
    chmodSync(configDir, 0o555);
    chmodSync(authPath, 0o444);

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(refreshSession(configDir, fetchFn as unknown as typeof fetch)).rejects.toThrow();
      // Lets any dangling promise's rejection microtask surface before asserting on it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      chmodSync(configDir, 0o755);
      chmodSync(authPath, 0o644);
    }
  });
});
