import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_FILENAME, type AuthSession } from "../../src/auth/authStore";
import type { refreshSession as refreshSessionReal } from "../../src/auth/refresh";
import { authedFetch } from "../../src/provider/authedFetch";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-authed-fetch-test-"));
  writeFileSync(
    join(tmpRoot, AUTH_FILENAME),
    JSON.stringify({
      accessToken: "at-1",
      refreshToken: "rt-1",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("authedFetch — the refresh call is never bound to a caller's own AbortSignal", () => {
  test("a 401 with a caller signal present still hands refreshSession the unbound fetchFn", async () => {
    const controller = new AbortController();
    const calls: (RequestInit | undefined)[] = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init);
      return calls.length === 1 ? jsonResponse({}, 401) : jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    let refreshReceivedSameFetchFn = false;
    const refreshSession: typeof refreshSessionReal = async (_configDir, refreshFetchFn) => {
      refreshReceivedSameFetchFn = refreshFetchFn === fetchFn;
      return {
        accessToken: "at-2",
        refreshToken: "rt-2",
        userId: "user_1",
        email: "a@example.com",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      };
    };

    await authedFetch(
      tmpRoot,
      fetchFn,
      refreshSession,
    )("https://example.invalid/thing", { signal: controller.signal });

    expect(refreshReceivedSameFetchFn).toBe(true);
  });

  test("no caller signal leaves the refresh fetchFn unbound too", async () => {
    const calls: (RequestInit | undefined)[] = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init);
      return calls.length === 1 ? jsonResponse({}, 401) : jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    let refreshReceivedSameFetchFn = false;
    const refreshSession: typeof refreshSessionReal = async (_configDir, refreshFetchFn) => {
      refreshReceivedSameFetchFn = refreshFetchFn === fetchFn;
      return {
        accessToken: "at-2",
        refreshToken: "rt-2",
        userId: "user_1",
        email: "a@example.com",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      };
    };

    await authedFetch(tmpRoot, fetchFn, refreshSession)("https://example.invalid/thing");

    expect(refreshReceivedSameFetchFn).toBe(true);
  });

  test("one caller's own signal aborting while a refresh is shared with another caller does not affect the other caller", async () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    let resolveRefresh!: (session: AuthSession) => void;
    const sharedRefresh = new Promise<AuthSession>((resolve) => {
      resolveRefresh = resolve;
    });
    const refreshSession: typeof refreshSessionReal = () => sharedRefresh;

    let fetchCalls = 0;
    const fetchFn = (async () => {
      fetchCalls++;
      return fetchCalls <= 2 ? jsonResponse({}, 401) : jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const pendingA = authedFetch(
      tmpRoot,
      fetchFn,
      refreshSession,
    )("https://example.invalid/thing", { signal: controllerA.signal });
    const pendingB = authedFetch(
      tmpRoot,
      fetchFn,
      refreshSession,
    )("https://example.invalid/thing", { signal: controllerB.signal });

    await new Promise((resolve) => setTimeout(resolve, 0));
    controllerA.abort();
    await expect(pendingA).rejects.toBeDefined();

    resolveRefresh({
      accessToken: "at-2",
      refreshToken: "rt-2",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
    });

    const responseB = await pendingB;
    expect(responseB.status).toBe(200);
  });
});
