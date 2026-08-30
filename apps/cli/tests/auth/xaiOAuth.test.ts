import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverXaiEndpoints,
  pollForXaiToken,
  readXaiTokens,
  requestXaiDeviceCode,
  XAI_ISSUER_DEFAULT,
  xaiClientId,
  xaiIssuer,
} from "../../src/auth/xaiOAuth";

function jsonResponse(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, text: async () => JSON.stringify(body) } as Response;
}

// bun-types augments the global fetch with a static `preconnect` member, so a bare async arrow is
// not assignable to `typeof fetch` — the same cast gateway.ts documents for its injected fetch.
function asFetch(fn: (url: any, init?: any) => Promise<Response>): typeof fetch {
  return fn as unknown as typeof fetch;
}

const DISCOVERY = {
  device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
  token_endpoint: "https://auth.x.ai/oauth2/token",
};

const ENDPOINTS = {
  deviceAuthorizationEndpoint: DISCOVERY.device_authorization_endpoint,
  tokenEndpoint: DISCOVERY.token_endpoint,
};

const DEVICE = {
  deviceCode: "device-abc",
  userCode: "69GR-4SVP",
  verificationUri: "https://accounts.x.ai/oauth2/device",
  verificationUriComplete: "https://accounts.x.ai/oauth2/device?user_code=69GR-4SVP",
  expiresIn: 1800,
  interval: 5,
};

function withTempConfig<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "seri-xai-oauth-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("client id configuration", () => {
  // The policy this asserts is the whole reason the feature ships switched off: xAI allowlists
  // OAuth client ids and has not issued one to seri, so baking in someone else's would be client
  // impersonation. A default appearing here is a policy regression, not a convenience.
  test("there is no default client id", () => {
    withTempConfig((dir) => {
      expect(xaiClientId(dir)).toBeUndefined();
    });
  });

  test("the issuer does have a default", () => {
    withTempConfig((dir) => {
      expect(xaiIssuer(dir)).toBe(XAI_ISSUER_DEFAULT);
    });
  });
});

describe("discoverXaiEndpoints", () => {
  test("reads the device and token endpoints from the discovery document", async () => {
    const endpoints = await discoverXaiEndpoints(
      "https://auth.x.ai",
      asFetch(async () => jsonResponse(true, 200, DISCOVERY)),
    );
    expect(endpoints).toEqual(ENDPOINTS);
  });

  // Host pinning is the control that stops a poisoned discovery document from redirecting refresh
  // traffic — which carries a long-lived, rotating refresh token — to an attacker's host.
  test("refuses a token endpoint on a different host than the issuer", async () => {
    await expect(
      discoverXaiEndpoints(
        "https://auth.x.ai",
        asFetch(async () =>
          jsonResponse(true, 200, {
            ...DISCOVERY,
            token_endpoint: "https://evil.example.com/oauth2/token",
          }),
        ),
      ),
    ).rejects.toThrow(/different host/);
  });

  test("refuses a device endpoint on a different host than the issuer", async () => {
    await expect(
      discoverXaiEndpoints(
        "https://auth.x.ai",
        asFetch(async () =>
          jsonResponse(true, 200, {
            ...DISCOVERY,
            device_authorization_endpoint: "https://evil.example.com/device",
          }),
        ),
      ),
    ).rejects.toThrow(/different host/);
  });

  test("throws when the discovery document omits an endpoint", async () => {
    await expect(
      discoverXaiEndpoints(
        "https://auth.x.ai",
        asFetch(async () => jsonResponse(true, 200, { token_endpoint: DISCOVERY.token_endpoint })),
      ),
    ).rejects.toThrow(/device_authorization_endpoint/);
  });

  test("throws on a non-ok discovery response", async () => {
    await expect(
      discoverXaiEndpoints(
        "https://auth.x.ai",
        asFetch(async () => jsonResponse(false, 503, {})),
      ),
    ).rejects.toThrow(/status 503/);
  });
});

describe("requestXaiDeviceCode", () => {
  test("posts the client id and scope, and maps the response", async () => {
    const bodies: string[] = [];
    const device = await requestXaiDeviceCode(
      "client-1",
      ENDPOINTS,
      asFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        return jsonResponse(true, 200, {
          device_code: "device-abc",
          user_code: "69GR-4SVP",
          verification_uri: DEVICE.verificationUri,
          verification_uri_complete: DEVICE.verificationUriComplete,
          expires_in: 1800,
          interval: 5,
        });
      }),
    );
    expect(device).toEqual(DEVICE);
    expect(bodies[0]).toContain("client_id=client-1");
    expect(bodies[0]).toContain("grok-cli%3Aaccess");
  });

  test("falls back to verification_uri when the complete form is absent", async () => {
    const device = await requestXaiDeviceCode(
      "client-1",
      ENDPOINTS,
      asFetch(async () =>
        jsonResponse(true, 200, {
          device_code: "d",
          user_code: "u",
          verification_uri: "https://accounts.x.ai/oauth2/device",
          expires_in: 900,
          interval: 5,
        }),
      ),
    );
    expect(device.verificationUriComplete).toBe("https://accounts.x.ai/oauth2/device");
  });
});

describe("readXaiTokens", () => {
  // A 200 carrying only half the pair would otherwise be persisted, leaving a connection that can
  // never refresh itself once the access token expires.
  test("rejects a payload with no refresh token", () => {
    expect(() => readXaiTokens({ access_token: "a" })).toThrow(/refresh_token/);
  });

  test("rejects a payload with no access token", () => {
    expect(() => readXaiTokens({ refresh_token: "r" })).toThrow(/access_token/);
  });

  test("carries expires_in and scope through when present", () => {
    expect(
      readXaiTokens({ access_token: "a", refresh_token: "r", expires_in: 21600, scope: "openid" }),
    ).toEqual({ accessToken: "a", refreshToken: "r", expiresIn: 21600, scope: "openid" });
  });
});

describe("pollForXaiToken", () => {
  const noSleep = async () => {};

  test("polls past authorization_pending and returns the tokens", async () => {
    let call = 0;
    const result = await pollForXaiToken("client-1", DEVICE, ENDPOINTS, {
      sleep: noSleep,
      fetchFn: asFetch(async () => {
        call += 1;
        if (call === 1) return jsonResponse(false, 400, { error: "authorization_pending" });
        return jsonResponse(true, 200, {
          access_token: "a",
          refresh_token: "r",
          expires_in: 21600,
        });
      }),
    });
    expect(result).toEqual({
      status: "success",
      value: { accessToken: "a", refreshToken: "r", expiresIn: 21600, scope: undefined },
    });
    expect(call).toBe(2);
  });

  test("slow_down raises the interval by five seconds", async () => {
    const waits: number[] = [];
    let call = 0;
    await pollForXaiToken("client-1", DEVICE, ENDPOINTS, {
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchFn: asFetch(async () => {
        call += 1;
        if (call === 1) return jsonResponse(false, 400, { error: "slow_down" });
        return jsonResponse(true, 200, { access_token: "a", refresh_token: "r" });
      }),
    });
    expect(waits).toEqual([5000, 10000]);
  });

  // The terminal case that must never be retried: the account signed in fine, its plan tier is
  // simply not allowed. Folding this into "error" would invite a retry loop that cannot succeed.
  test("a 403 is tier-denied, is distinct from error, and stops polling", async () => {
    let call = 0;
    const result = await pollForXaiToken("client-1", DEVICE, ENDPOINTS, {
      sleep: noSleep,
      fetchFn: asFetch(async () => {
        call += 1;
        return jsonResponse(false, 403, { error_description: "Your plan does not include this" });
      }),
    });
    expect(result).toEqual({ status: "tier-denied", message: "Your plan does not include this" });
    expect(call).toBe(1);
  });

  test("access_denied is terminal and distinct from an unexpected error", async () => {
    const result = await pollForXaiToken("client-1", DEVICE, ENDPOINTS, {
      sleep: noSleep,
      fetchFn: asFetch(async () => jsonResponse(false, 400, { error: "access_denied" })),
    });
    expect(result).toEqual({ status: "denied" });
  });

  test("expired_token is terminal", async () => {
    const result = await pollForXaiToken("client-1", DEVICE, ENDPOINTS, {
      sleep: noSleep,
      fetchFn: asFetch(async () => jsonResponse(false, 400, { error: "expired_token" })),
    });
    expect(result).toEqual({ status: "expired" });
  });

  test("returns aborted without polling when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const result = await pollForXaiToken("client-1", DEVICE, ENDPOINTS, {
      sleep: noSleep,
      signal: controller.signal,
      fetchFn: asFetch(async () => {
        called = true;
        return jsonResponse(true, 200, {});
      }),
    });
    expect(result).toEqual({ status: "aborted" });
    expect(called).toBe(false);
  });

  // The thermo-nuclear round-5 race, now covered on this flow too: an abort landing WHILE the
  // request is in flight must discard even a genuine success rather than persist it one tick late.
  test("discards a success when the abort lands during the in-flight request", async () => {
    const controller = new AbortController();
    const result = await pollForXaiToken("client-1", DEVICE, ENDPOINTS, {
      sleep: noSleep,
      signal: controller.signal,
      fetchFn: asFetch(async () => {
        controller.abort();
        return jsonResponse(true, 200, { access_token: "a", refresh_token: "r" });
      }),
    });
    expect(result).toEqual({ status: "aborted" });
  });
});
