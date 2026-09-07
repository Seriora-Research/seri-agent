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


  test("a 200 response missing token fields returns {status: 'error'}", async () => {
    const fetchFn = async () => fakeResponse(true, 200, { expires_in: 300 });

    const result = await refreshAccessToken(
      "client_123",
      "rt-old",
      fetchFn as unknown as typeof fetch,
    );

    expect(result.status).toBe("error");
  });



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




    chmodSync(configDir, 0o555);
    chmodSync(authPath, 0o444);

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(refreshSession(configDir, fetchFn as unknown as typeof fetch)).rejects.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      chmodSync(configDir, 0o755);
      chmodSync(authPath, 0o644);
    }
  });
});
