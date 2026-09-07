import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverXaiEndpoints,
  fetchXaiAccountId,
  pollForXaiToken,
  readXaiTokens,
  requestXaiDeviceCode,
  validXaiAccountId,
  XAI_CLIENT_ID_DEFAULT,
  XAI_ISSUER_DEFAULT,
  xaiClientId,
  xaiIssuer,
} from "../../src/auth/xaiOAuth";

function jsonResponse(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, text: async () => JSON.stringify(body) } as Response;
}



function asFetch(fn: (url: any, init?: any) => Promise<Response>): typeof fetch {
  return fn as unknown as typeof fetch;
}

const DISCOVERY = {
  device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
  token_endpoint: "https://auth.x.ai/oauth2/token",
  userinfo_endpoint: "https://auth.x.ai/oauth2/userinfo",
};

const ENDPOINTS = {
  deviceAuthorizationEndpoint: DISCOVERY.device_authorization_endpoint,
  tokenEndpoint: DISCOVERY.token_endpoint,
  userinfoEndpoint: DISCOVERY.userinfo_endpoint,
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


  test("the default is Grok Build's borrowed client id", () => {
    withTempConfig((dir) => {
      expect(xaiClientId(dir)).toBe(XAI_CLIENT_ID_DEFAULT);
      expect(XAI_CLIENT_ID_DEFAULT).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    });
  });

  test("SERI_GROK_CLIENT_ID overrides the default", () => {
    withTempConfig((dir) => {
      process.env.SERI_GROK_CLIENT_ID = "custom-id";
      try {
        expect(xaiClientId(dir)).toBe("custom-id");
      } finally {
        delete process.env.SERI_GROK_CLIENT_ID;
      }
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



  test("refuses a token endpoint on a different origin than the issuer", async () => {
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
    ).rejects.toThrow(/different origin/);
  });

  test("refuses a device endpoint on a different origin than the issuer", async () => {
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
    ).rejects.toThrow(/different origin/);
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

describe("validXaiAccountId", () => {
  test("accepts printable ASCII between 1 and 1024 chars", () => {
    expect(validXaiAccountId("acct-1")).toBe(true);
    expect(validXaiAccountId("A")).toBe(true);
  });

  test("rejects empty, overlong, and non-printable values", () => {
    expect(validXaiAccountId("")).toBe(false);
    expect(validXaiAccountId("a".repeat(1025))).toBe(false);
    expect(validXaiAccountId("acct\n1")).toBe(false);
    expect(validXaiAccountId("acct 1")).toBe(false);
  });
});

describe("fetchXaiAccountId", () => {
  test("reads sub from userinfo", async () => {
    const id = await fetchXaiAccountId(
      "tok",
      ENDPOINTS.userinfoEndpoint,
      asFetch(async () => jsonResponse(true, 200, { sub: "acct-42" })),
    );
    expect(id).toBe("acct-42");
  });

  test("rejects a missing or unusable sub", async () => {
    await expect(
      fetchXaiAccountId(
        "tok",
        ENDPOINTS.userinfoEndpoint,
        asFetch(async () => jsonResponse(true, 200, { sub: "acct\nid" })),
      ),
    ).rejects.toThrow(/no usable account id/);
  });
});

describe("discovery scheme pinning", () => {


  test("refuses an http endpoint for an https issuer", async () => {
    await expect(
      discoverXaiEndpoints(
        "https://auth.x.ai",
        asFetch(async () =>
          jsonResponse(true, 200, {
            ...DISCOVERY,
            token_endpoint: "http://auth.x.ai/oauth2/token",
          }),
        ),
      ),
    ).rejects.toThrow(/different origin/);
  });

  test("falls back to issuer/oauth2/userinfo when userinfo_endpoint is omitted", async () => {
    const endpoints = await discoverXaiEndpoints(
      "https://auth.x.ai",
      asFetch(async () =>
        jsonResponse(true, 200, {
          device_authorization_endpoint: DISCOVERY.device_authorization_endpoint,
          token_endpoint: DISCOVERY.token_endpoint,
        }),
      ),
    );
    expect(endpoints.userinfoEndpoint).toBe("https://auth.x.ai/oauth2/userinfo");
  });
});
