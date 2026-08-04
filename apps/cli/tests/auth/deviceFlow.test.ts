import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigValue } from "../../src/config/config";
import {
  DEFAULT_WORKOS_CLIENT_ID,
  type DeviceAuthorization,
  getWorkosClientId,
  pollForToken,
  requestDeviceCode,
} from "../../src/auth/deviceFlow";

function fakeResponse(ok: boolean, body: unknown): Response {
  return { ok, text: async () => JSON.stringify(body) } as Response;
}

function fakeTextResponse(ok: boolean, status: number, text: string): Response {
  return { ok, status, text: async () => text } as Response;
}

describe("getWorkosClientId", () => {
  const original = process.env.SERI_WORKOS_CLIENT_ID;
  let configDir: string;

  beforeEach(() => {
    // Read from a temp dir, never the developer's real config: WORKOS-PRODUCTION.md tells
    // users to put SERI_WORKOS_CLIENT_ID in config.json, so a test that resolves the real
    // config dir would fail on the machine of anyone who followed those instructions.
    configDir = mkdtempSync(join(tmpdir(), "seri-clientid-test-"));
  });

  afterEach(() => {
    // Restore by deleting when it was unset — reassigning `undefined` stores the literal
    // string "undefined" in Node/Bun and leaks into later tests in the same process.
    if (original === undefined) delete process.env.SERI_WORKOS_CLIENT_ID;
    else process.env.SERI_WORKOS_CLIENT_ID = original;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("falls back to the built-in default when unset", () => {
    delete process.env.SERI_WORKOS_CLIENT_ID;

    expect(getWorkosClientId(configDir)).toBe(DEFAULT_WORKOS_CLIENT_ID);
  });

  test("prefers SERI_WORKOS_CLIENT_ID when set", () => {
    process.env.SERI_WORKOS_CLIENT_ID = "client_override_123";

    expect(getWorkosClientId(configDir)).toBe("client_override_123");
  });

  test("reads from config.json when the env var is unset", () => {
    delete process.env.SERI_WORKOS_CLIENT_ID;
    setConfigValue("SERI_WORKOS_CLIENT_ID", "client_from_config", configDir);

    expect(getWorkosClientId(configDir)).toBe("client_from_config");
  });

  test("ignores an empty env var instead of sending an empty client id", () => {
    process.env.SERI_WORKOS_CLIENT_ID = "";

    expect(getWorkosClientId(configDir)).toBe(DEFAULT_WORKOS_CLIENT_ID);
  });
});

describe("requestDeviceCode", () => {
  test("posts client_id as JSON and maps the snake_case response to camelCase", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchFn = async (url: string, init: RequestInit) => {
      captured = { url, init };
      return fakeResponse(true, {
        device_code: "dc-1",
        user_code: "ABCD-1234",
        verification_uri: "https://example.com/device",
        verification_uri_complete: "https://example.com/device?user_code=ABCD-1234",
        expires_in: 300,
        interval: 5,
      });
    };

    const result = await requestDeviceCode("client_123", fetchFn as unknown as typeof fetch);

    expect(result).toEqual({
      deviceCode: "dc-1",
      userCode: "ABCD-1234",
      verificationUri: "https://example.com/device",
      verificationUriComplete: "https://example.com/device?user_code=ABCD-1234",
      expiresIn: 300,
      interval: 5,
    });
    expect(captured?.url).toBe("https://api.workos.com/user_management/authorize/device");
    expect(captured?.init.method).toBe("POST");
    expect(captured?.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(captured?.init.body).toBe(JSON.stringify({ client_id: "client_123" }));
  });

  test("throws when the response is not ok instead of returning undefined fields", async () => {
    const fetchFn = async () =>
      ({ ok: false, status: 429, text: async () => JSON.stringify({ error: "rate_limited" }) }) as Response;

    await expect(requestDeviceCode("client_123", fetchFn as unknown as typeof fetch)).rejects.toThrow();
  });

  test("throws a clean error instead of an unhandled SyntaxError when the error body isn't valid JSON", async () => {
    const fetchFn = async () => fakeTextResponse(false, 502, "<html>502 Bad Gateway</html>");

    await expect(requestDeviceCode("client_123", fetchFn as unknown as typeof fetch)).rejects.toThrow(
      /WorkOS device authorization failed with status 502/,
    );
  });
});

describe("pollForToken", () => {
  const device: DeviceAuthorization = {
    deviceCode: "dc-1",
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
    verificationUriComplete: "https://example.com/device?user_code=ABCD-1234",
    expiresIn: 300,
    interval: 5,
  };

  test("waits `interval` seconds between polls and returns the token on success", async () => {
    const responses = [
      fakeResponse(false, { error: "authorization_pending" }),
      fakeResponse(false, { error: "authorization_pending" }),
      fakeResponse(true, {
        access_token: "at-1",
        refresh_token: "rt-1",
        user: { id: "user_1", email: "a@example.com" },
      }),
    ];
    const fetchFn = (async () => responses.shift() as Response) as unknown as typeof fetch;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const result = await pollForToken("client_123", device, { fetchFn, sleep, now: () => 0 });

    expect(result).toEqual({
      status: "success",
      accessToken: "at-1",
      refreshToken: "rt-1",
      user: { id: "user_1", email: "a@example.com" },
    });
    expect(sleepCalls).toEqual([5000, 5000, 5000]);
  });

  test("slow_down increases the wait by 5 seconds for subsequent polls", async () => {
    const responses = [
      fakeResponse(false, { error: "authorization_pending" }),
      fakeResponse(false, { error: "slow_down" }),
      fakeResponse(true, {
        access_token: "at-1",
        refresh_token: "rt-1",
        user: { id: "user_1", email: "a@example.com" },
      }),
    ];
    const fetchFn = (async () => responses.shift() as Response) as unknown as typeof fetch;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    await pollForToken("client_123", device, { fetchFn, sleep, now: () => 0 });

    expect(sleepCalls).toEqual([5000, 5000, 10000]);
  });

  test("access_denied is terminal and returns {status: 'denied'} without further polling", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return fakeResponse(false, { error: "access_denied" });
    }) as unknown as typeof fetch;

    const result = await pollForToken("client_123", device, { fetchFn, sleep: async () => {}, now: () => 0 });

    expect(result).toEqual({ status: "denied" });
    expect(calls).toBe(1);
  });

  test("expired_token is terminal and returns {status: 'expired'}", async () => {
    const fetchFn = (async () => fakeResponse(false, { error: "expired_token" })) as unknown as typeof fetch;

    const result = await pollForToken("client_123", device, { fetchFn, sleep: async () => {}, now: () => 0 });

    expect(result).toEqual({ status: "expired" });
  });

  test("an unexpected error code (e.g. invalid_client) is terminal and returns {status: 'error'}, not 'denied'", async () => {
    const fetchFn = (async () => fakeResponse(false, { error: "invalid_client" })) as unknown as typeof fetch;

    const result = await pollForToken("client_123", device, { fetchFn, sleep: async () => {}, now: () => 0 });

    expect(result).toEqual({
      status: "error",
      message: "WorkOS returned an unexpected error during authentication: invalid_client",
    });
  });

  test("client-side backstop: expires when injected now() passes device.expiresIn before a terminal response arrives", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return fakeResponse(false, { error: "authorization_pending" });
    }) as unknown as typeof fetch;
    // now() sequence: 0 (deadline calc), 0 (pre-poll check, not yet expired — one poll
    // happens), then past the 300s expiry (pre-poll check for the would-be second poll).
    const nowValues = [0, 0, 301_000];
    const now = () => nowValues.shift() ?? 301_000;

    const result = await pollForToken("client_123", device, { fetchFn, sleep: async () => {}, now });

    expect(result).toEqual({ status: "expired" });
    expect(calls).toBe(1);
  });
});
