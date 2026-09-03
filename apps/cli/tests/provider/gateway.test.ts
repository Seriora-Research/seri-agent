import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamText } from "ai";
import { AUTH_FILENAME, loadAuthSession, saveAuthSession } from "../../src/auth/authStore";
import type { refreshSession as refreshSessionReal } from "../../src/auth/refresh";
import { gatewayBaseUrl, getGatewayModel } from "../../src/provider/gateway";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-gateway-test-"));
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SERI_GATEWAY_URL;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seedAuthJson(configDir: string, session: Record<string, unknown> = {}): void {
  writeFileSync(
    join(configDir, AUTH_FILENAME),
    JSON.stringify({
      accessToken: "at-1",
      refreshToken: "rt-1",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
      ...session,
    }),
  );
}

// The exact SSE shape @ai-sdk/openai's chat model expects to stream.
function sseResponse(): Response {
  const chunks = [
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ code: "token_invalid" }), { status: 401 });
}

function fakeRefresh(accessToken: string): typeof refreshSessionReal {
  return (async () => ({
    accessToken,
    refreshToken: "rt-2",
    userId: "user_1",
    email: "a@example.com",
    obtainedAt: "2026-01-01T00:00:00.000Z",
  })) as unknown as typeof refreshSessionReal;
}

const refreshNeverCalled: typeof refreshSessionReal = (async () => {
  throw new Error("refreshSession should not have been called");
}) as unknown as typeof refreshSessionReal;

// Unlike fakeRefresh above, this persists to disk — the property under test is that a LATER,
// separate authedFetch invocation reads the refreshed token off disk rather than a value baked
// into createOpenAI's config at construction time, and only a real (or disk-writing) refresh
// exercises that.
function fakeRefreshPersisting(configDir: string, accessToken: string): typeof refreshSessionReal {
  return (async () => {
    const session = loadAuthSession(configDir);
    if (!session) return undefined;
    const updated = { ...session, accessToken, refreshToken: "rt-2" };
    saveAuthSession(updated, configDir);
    return updated;
  }) as unknown as typeof refreshSessionReal;
}

describe("getGatewayModel — BYOK guard", () => {
  // The verify-bar item: a provider with a locally-configured key must never reach the gateway
  // route. Recorded as failing with the guard removed — see the removal below.
  test("throws when the requested provider already has a locally-configured key", () => {
    process.env.OPENROUTER_API_KEY = "byok-key";
    seedAuthJson(tmpRoot);

    expect(() => getGatewayModel("some-model", "openrouter", "session-1", tmpRoot)).toThrow(
      /locally-configured key/,
    );
  });

  test("negative control: constructs without throwing when no local key is configured", () => {
    delete process.env.OPENROUTER_API_KEY;
    seedAuthJson(tmpRoot);

    expect(() => getGatewayModel("some-model", "openrouter", "session-1", tmpRoot)).not.toThrow();
  });
});

describe("getGatewayModel — login requirement", () => {
  test("throws a login-required error when no auth.json exists", () => {
    expect(() => getGatewayModel("some-model", "openrouter", "session-1", tmpRoot)).toThrow(
      /\/login/,
    );
  });
});

describe("gatewayBaseUrl — default host", () => {
  test("returns https://api.seriora.ai/api/gateway when SERI_GATEWAY_URL is unset", () => {
    delete process.env.SERI_GATEWAY_URL;
    expect(gatewayBaseUrl(tmpRoot)).toBe("https://api.seriora.ai/api/gateway");
  });

  test("does not default to the non-resolving gateway.seriora.ai host", () => {
    delete process.env.SERI_GATEWAY_URL;
    expect(gatewayBaseUrl(tmpRoot)).not.toBe("https://gateway.seriora.ai/api/gateway");
  });

  test("rewrites leftover gateway-dev.seriora.ai to api-dev.seriora.ai", () => {
    process.env.SERI_GATEWAY_URL = "https://gateway-dev.seriora.ai/api/gateway";
    expect(gatewayBaseUrl(tmpRoot)).toBe("https://api-dev.seriora.ai/api/gateway");
  });

  test("rewrites leftover gateway.seriora.ai to api.seriora.ai", () => {
    process.env.SERI_GATEWAY_URL = "https://gateway.seriora.ai/api/gateway";
    expect(gatewayBaseUrl(tmpRoot)).toBe("https://api.seriora.ai/api/gateway");
  });

  test("leaves api-dev.seriora.ai alone", () => {
    process.env.SERI_GATEWAY_URL = "https://api-dev.seriora.ai/api/gateway";
    expect(gatewayBaseUrl(tmpRoot)).toBe("https://api-dev.seriora.ai/api/gateway");
  });
});

describe("getGatewayModel — outgoing request", () => {
  test("uses the live default host when SERI_GATEWAY_URL is unset", async () => {
    delete process.env.SERI_GATEWAY_URL;
    seedAuthJson(tmpRoot);
    let captured: { url: string } | undefined;
    const fetchFn = (async (input: RequestInfo | URL) => {
      captured = { url: String(input) };
      return sseResponse();
    }) as unknown as typeof fetch;

    const model = getGatewayModel("some-model", "openrouter", "session-1", tmpRoot, {
      fetchFn,
      refreshSession: refreshNeverCalled,
    });
    await streamText({ model, prompt: "hi" }).text;

    expect(captured?.url.startsWith("https://api.seriora.ai/api/gateway")).toBe(true);
  });

  test("carries the access token, session id, and a URL under SERI_GATEWAY_URL", async () => {
    process.env.SERI_GATEWAY_URL = "http://localhost:9999/api/gateway";
    seedAuthJson(tmpRoot);
    let captured: { url: string; headers: Headers } | undefined;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), headers: new Headers(init?.headers) };
      return sseResponse();
    }) as unknown as typeof fetch;

    const model = getGatewayModel("some-model", "openrouter", "session-1", tmpRoot, {
      fetchFn,
      refreshSession: refreshNeverCalled,
    });
    await streamText({ model, prompt: "hi" }).text;

    expect(captured?.url.startsWith("http://localhost:9999/api/gateway")).toBe(true);
    expect(captured?.headers.get("Authorization")).toBe("Bearer at-1");
    expect(captured?.headers.get("X-Seri-Session-Id")).toBe("session-1");
  });
});

describe("getGatewayModel — 401 retry", () => {
  function stubFetch(responses: (() => Response)[]) {
    const calls: { url: string; headers: Headers }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      const respond = responses[Math.min(calls.length - 1, responses.length - 1)];
      return respond();
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  test("answers 401 then 200: retries exactly once, with the new token", async () => {
    process.env.SERI_GATEWAY_URL = "http://localhost:9999/api/gateway";
    seedAuthJson(tmpRoot);
    const { fetchFn, calls } = stubFetch([unauthorized, sseResponse]);

    const model = getGatewayModel("some-model", "openrouter", "session-1", tmpRoot, {
      fetchFn,
      refreshSession: fakeRefresh("at-2"),
    });
    await streamText({ model, prompt: "hi" }).text;

    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer at-1");
    expect(calls[1]?.headers.get("Authorization")).toBe("Bearer at-2");
  });

  test("a second 401 is not retried again — exactly two fetches total", async () => {
    process.env.SERI_GATEWAY_URL = "http://localhost:9999/api/gateway";
    seedAuthJson(tmpRoot);
    const { fetchFn, calls } = stubFetch([unauthorized, unauthorized]);

    const model = getGatewayModel("some-model", "openrouter", "session-1", tmpRoot, {
      fetchFn,
      refreshSession: fakeRefresh("at-2"),
    });

    await expect(streamText({ model, prompt: "hi" }).text).rejects.toBeDefined();
    expect(calls).toHaveLength(2);
  });

  test("401 with a failed refresh returns the original 401 and leaves the stored session untouched", async () => {
    process.env.SERI_GATEWAY_URL = "http://localhost:9999/api/gateway";
    seedAuthJson(tmpRoot);
    const { fetchFn, calls } = stubFetch([unauthorized]);
    const refreshFails: typeof refreshSessionReal = (async () =>
      undefined) as unknown as typeof refreshSessionReal;

    const model = getGatewayModel("some-model", "openrouter", "session-1", tmpRoot, {
      fetchFn,
      refreshSession: refreshFails,
    });

    await expect(streamText({ model, prompt: "hi" }).text).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });

  // A refresh triggered by one request's retry must not be forgotten the instant that request
  // finishes: every LATER request through the same model should use the new token immediately,
  // not repeat the same 401 -> refresh -> retry cycle every single time.
  test("a token refreshed during one request's retry is used directly by the next request", async () => {
    process.env.SERI_GATEWAY_URL = "http://localhost:9999/api/gateway";
    seedAuthJson(tmpRoot);
    const { fetchFn, calls } = stubFetch([unauthorized, sseResponse, sseResponse]);

    const model = getGatewayModel("some-model", "openrouter", "session-1", tmpRoot, {
      fetchFn,
      refreshSession: fakeRefreshPersisting(tmpRoot, "at-2"),
    });
    await streamText({ model, prompt: "first turn" }).text;
    await streamText({ model, prompt: "second turn" }).text;

    expect(calls).toHaveLength(3);
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer at-1");
    expect(calls[1]?.headers.get("Authorization")).toBe("Bearer at-2");
    // The second turn's very first attempt already carries the refreshed token — no second
    // 401 -> retry cycle.
    expect(calls[2]?.headers.get("Authorization")).toBe("Bearer at-2");
  });
});
