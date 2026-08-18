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

// Regression, corrected: an earlier version of this file bound the CALLING request's own
// AbortSignal into the fetchFn handed to refreshSession, on the theory that a stalled refresh
// should abort on the same deadline as the rest of the call. That reasoning only holds for a
// single caller — refreshSession's own in-flight map (auth/refresh.ts) shares ONE refresh across
// every concurrent 401 for the same configDir (its own comment: several reader subagents hitting
// the same gateway model), so binding the FIRST caller's signal into that shared operation let
// that caller's own cancellation abort every OTHER concurrent caller's wait too, even though their
// own deadlines never expired. The fix: the fetchFn refreshSession receives is never bound to any
// caller's signal, with or without one; refreshAccessToken now carries its own independent bounded
// lifetime instead (auth/refresh.ts's own REFRESH_TIMEOUT_MS). Only this caller's own WAIT for the
// result races its own signal — proven separately below.
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

  // The actual regression this fix closes, proven directly: two concurrent callers (e.g. two
  // reader subagents) sharing one in-flight refresh — controllerA aborts while both are still
  // waiting on it. Only A's own call must reject; B must still resolve normally once the shared
  // refresh eventually settles, proving A's cancellation never reached the operation B also
  // depends on.
  test("one caller's own signal aborting while a refresh is shared with another caller does not affect the other caller", async () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    let resolveRefresh!: (session: AuthSession) => void;
    const sharedRefresh = new Promise<AuthSession>((resolve) => {
      resolveRefresh = resolve;
    });
    const refreshSession: typeof refreshSessionReal = () => sharedRefresh;

    // A's own request (1) is the only fetchFn call it ever makes — it aborts while awaiting the
    // shared refresh, before reaching a retry. B's request (2) also 401s, then retries (3) once
    // the shared refresh resolves.
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

    // Lets both 401 paths land and start awaiting the shared refresh before A aborts.
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
