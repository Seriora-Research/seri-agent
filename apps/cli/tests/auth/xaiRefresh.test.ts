import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearXaiSubscription,
  hasXaiSubscription,
  loadXaiSubscription,
  saveXaiSubscription,
  XAI_AUTH_FILENAME,
} from "../../src/auth/xaiAuthStore";
import { XAI_CLIENT_ID_DEFAULT } from "../../src/auth/xaiOAuth";
import { refreshXaiSubscription, xaiAuthedFetch } from "../../src/auth/xaiRefresh";
import { setConfigValue } from "../../src/config/config";

function jsonResponse(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, text: async () => JSON.stringify(body) } as Response;
}

const DISCOVERY = {
  device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
  token_endpoint: "https://auth.x.ai/oauth2/token",
  userinfo_endpoint: "https://auth.x.ai/oauth2/userinfo",
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seri-xai-refresh-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function connect(refreshToken = "refresh-1"): void {
  saveXaiSubscription(
    { accessToken: "access-1", refreshToken, obtainedAt: new Date().toISOString() },
    dir,
  );
}



function fakeIssuer(onToken: (body: string) => Response): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (String(url).includes(".well-known")) return jsonResponse(true, 200, DISCOVERY);
    return onToken(String(init?.body));
  }) as unknown as typeof fetch;
}

describe("the store", () => {
  test("round-trips a subscription", () => {
    connect();
    expect(loadXaiSubscription(dir)?.accessToken).toBe("access-1");
    expect(hasXaiSubscription(dir)).toBe(true);
  });


  test("a malformed file reads as not connected rather than throwing", () => {
    writeFileSync(join(dir, XAI_AUTH_FILENAME), "{ not json");
    expect(loadXaiSubscription(dir)).toBeUndefined();
    expect(hasXaiSubscription(dir)).toBe(false);
  });

  test("a file missing the token pair reads as not connected", () => {
    writeFileSync(join(dir, XAI_AUTH_FILENAME), JSON.stringify({ accessToken: "a" }));
    expect(loadXaiSubscription(dir)).toBeUndefined();
  });

  test("clearing removes the file", () => {
    connect();
    clearXaiSubscription(dir);
    expect(loadXaiSubscription(dir)).toBeUndefined();
  });

  test("clearing when nothing is connected is not an error", () => {
    expect(() => clearXaiSubscription(dir)).not.toThrow();
  });
});

describe("refreshXaiSubscription", () => {
  test("with no SERI_GROK_CLIENT_ID it still refreshes using the borrowed default", async () => {
    connect();
    const sent: string[] = [];
    const result = await refreshXaiSubscription(
      dir,
      fakeIssuer((body) => {
        sent.push(body);
        return jsonResponse(true, 200, { access_token: "access-2", refresh_token: "refresh-2" });
      }),
    );
    expect(result.status).toBe("ok");
    expect(sent[0]).toContain(`client_id=${XAI_CLIENT_ID_DEFAULT}`);
  });

  test("with no stored subscription it reports not-connected", async () => {
    setConfigValue("SERI_GROK_CLIENT_ID", "client-1", dir);
    const result = await refreshXaiSubscription(dir, (async () =>
      jsonResponse(true, 200, {})) as unknown as typeof fetch);
    expect(result).toEqual({ status: "not-connected" });
  });



  test("persists the rotated refresh token, and the next refresh sends the new one", async () => {
    setConfigValue("SERI_GROK_CLIENT_ID", "client-1", dir);
    connect("refresh-1");
    const sent: string[] = [];
    const fetchFn = fakeIssuer((body) => {
      sent.push(body);
      const n = sent.length;
      return jsonResponse(true, 200, {
        access_token: `access-${n + 1}`,
        refresh_token: `refresh-${n + 1}`,
        expires_in: 21600,
      });
    });

    const first = await refreshXaiSubscription(dir, fetchFn);
    expect(first.status).toBe("ok");
    expect(loadXaiSubscription(dir)?.refreshToken).toBe("refresh-2");

    const second = await refreshXaiSubscription(dir, fetchFn);
    expect(second.status).toBe("ok");
    expect(sent[0]).toContain("refresh_token=refresh-1");
    expect(sent[1]).toContain("refresh_token=refresh-2");
  });

  test("a 200 missing the refresh token is an error and leaves the stored pair untouched", async () => {
    setConfigValue("SERI_GROK_CLIENT_ID", "client-1", dir);
    connect("refresh-1");
    const result = await refreshXaiSubscription(
      dir,
      fakeIssuer(() => jsonResponse(true, 200, { access_token: "access-2" })),
    );
    expect(result.status).toBe("error");
    expect(loadXaiSubscription(dir)?.refreshToken).toBe("refresh-1");
  });

  test("a 403 is tier-denied and never overwrites the stored credential", async () => {
    setConfigValue("SERI_GROK_CLIENT_ID", "client-1", dir);
    connect("refresh-1");
    const result = await refreshXaiSubscription(
      dir,
      fakeIssuer(() => jsonResponse(false, 403, { error_description: "tier not allowed" })),
    );
    expect(result).toEqual({ status: "tier-denied", message: "tier not allowed" });
    expect(loadXaiSubscription(dir)?.refreshToken).toBe("refresh-1");
  });



  test("concurrent refreshes share a single token request", async () => {
    setConfigValue("SERI_GROK_CLIENT_ID", "client-1", dir);
    connect("refresh-1");
    let tokenCalls = 0;
    const fetchFn = fakeIssuer(() => {
      tokenCalls += 1;
      return jsonResponse(true, 200, { access_token: "access-2", refresh_token: "refresh-2" });
    });

    const results = await Promise.all([
      refreshXaiSubscription(dir, fetchFn),
      refreshXaiSubscription(dir, fetchFn),
      refreshXaiSubscription(dir, fetchFn),
    ]);
    expect(tokenCalls).toBe(1);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(loadXaiSubscription(dir)?.refreshToken).toBe("refresh-2");
  });

  test("refresh keeps the stored accountId", async () => {
    setConfigValue("SERI_GROK_CLIENT_ID", "client-1", dir);
    saveXaiSubscription(
      {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        obtainedAt: new Date().toISOString(),
        accountId: "acct-keep",
      },
      dir,
    );
    const result = await refreshXaiSubscription(
      dir,
      fakeIssuer(() =>
        jsonResponse(true, 200, { access_token: "access-2", refresh_token: "refresh-2" }),
      ),
    );
    expect(result.status).toBe("ok");
    expect(loadXaiSubscription(dir)?.accountId).toBe("acct-keep");
  });
});

describe("xaiAuthedFetch", () => {
  test("attaches the bearer token", async () => {
    connect();
    const seen: string[] = [];
    const wrapped = xaiAuthedFetch(dir, (async (_url: string, init?: RequestInit) => {
      seen.push(String(new Headers(init?.headers).get("authorization")));
      return jsonResponse(true, 200, {});
    }) as unknown as typeof fetch);
    await wrapped("https://api.x.ai/v1/chat/completions");
    expect(seen[0]).toBe("Bearer access-1");
  });

  test("refreshes once on a 401 and retries with the new token", async () => {
    setConfigValue("SERI_GROK_CLIENT_ID", "client-1", dir);
    connect("refresh-1");
    const auths: string[] = [];
    const wrapped = xaiAuthedFetch(dir, (async (url: string, init?: RequestInit) => {
      if (String(url).includes(".well-known")) return jsonResponse(true, 200, DISCOVERY);
      if (String(url).includes("oauth2/token")) {
        return jsonResponse(true, 200, { access_token: "access-2", refresh_token: "refresh-2" });
      }
      const auth = String(new Headers(init?.headers).get("authorization"));
      auths.push(auth);
      if (auth === "Bearer access-1") return jsonResponse(false, 401, {});
      return jsonResponse(true, 200, {});
    }) as unknown as typeof fetch);

    const response = await wrapped("https://api.x.ai/v1/chat/completions");
    expect(response.ok).toBe(true);
    expect(auths).toEqual(["Bearer access-1", "Bearer access-2"]);
  });



  test("a 403 passes through without triggering a refresh", async () => {
    setConfigValue("SERI_GROK_CLIENT_ID", "client-1", dir);
    connect("refresh-1");
    let tokenCalls = 0;
    const wrapped = xaiAuthedFetch(dir, (async (url: string) => {
      if (String(url).includes("oauth2/token")) {
        tokenCalls += 1;
        return jsonResponse(true, 200, { access_token: "x", refresh_token: "y" });
      }
      if (String(url).includes(".well-known")) return jsonResponse(true, 200, DISCOVERY);
      return jsonResponse(false, 403, { error: "tier" });
    }) as unknown as typeof fetch);

    const response = await wrapped("https://api.x.ai/v1/chat/completions");
    expect(response.status).toBe(403);
    expect(tokenCalls).toBe(0);
    expect(loadXaiSubscription(dir)?.refreshToken).toBe("refresh-1");
  });

  test("throws a directing message when nothing is connected", async () => {
    const wrapped = xaiAuthedFetch(dir, (async () =>
      jsonResponse(true, 200, {})) as unknown as typeof fetch);
    await expect(wrapped("https://api.x.ai/v1/chat/completions")).rejects.toThrow(/\/setup/);
  });
});

describe("the stored file", () => {
  test("is written owner-only on POSIX", () => {
    connect();
    const raw = readFileSync(join(dir, XAI_AUTH_FILENAME), "utf8");
    expect(JSON.parse(raw).accessToken).toBe("access-1");
  });
});

describe("a dead rotated refresh token", () => {


  test("invalid_grant is reconnect-required, not a retryable error", async () => {
    setConfigValue("SERI_GROK_CLIENT_ID", "client-1", dir);
    connect("refresh-dead");
    const result = await refreshXaiSubscription(
      dir,
      fakeIssuer(() => jsonResponse(false, 400, { error: "invalid_grant" })),
    );
    expect(result.status).toBe("reconnect-required");
    expect(loadXaiSubscription(dir)?.refreshToken).toBe("refresh-dead");
  });
});
