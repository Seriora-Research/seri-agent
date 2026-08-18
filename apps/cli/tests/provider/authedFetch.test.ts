import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_FILENAME } from "../../src/auth/authStore";
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

// Regression: refreshSession's own fetch (refreshAccessToken's POST to WorkOS) used to take no
// signal at all, so a caller's deadline (e.g. accountStatus.ts's ACCOUNT_STATUS_TIMEOUT_MS)
// bounded the first fetch and the post-refresh retry, but not a refresh stalled in between —
// defeating the deadline on any 401. authedFetch must thread the caller's own signal into the
// fetchFn it hands refreshSession, so a stalled refresh aborts on the same deadline as the rest
// of the call.
describe("authedFetch — refresh call inherits the caller's AbortSignal", () => {
  test("a 401 threads the caller's signal into the fetchFn refreshSession receives", async () => {
    const controller = new AbortController();
    const calls: (RequestInit | undefined)[] = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init);
      return calls.length === 1 ? jsonResponse({}, 401) : jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const refreshSession: typeof refreshSessionReal = (async (_configDir, refreshFetchFn) => {
      await refreshFetchFn?.("https://example.invalid/refresh", {});
      return {
        accessToken: "at-2",
        refreshToken: "rt-2",
        userId: "user_1",
        email: "a@example.com",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      };
    }) as unknown as typeof refreshSessionReal;

    await authedFetch(
      tmpRoot,
      fetchFn,
      refreshSession,
    )("https://example.invalid/thing", { signal: controller.signal });

    expect(calls).toHaveLength(3);
    expect(calls[1]?.signal).toBe(controller.signal);
  });

  test("no caller signal leaves the refresh fetchFn unbound, unchanged from before this fix", async () => {
    const calls: (RequestInit | undefined)[] = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init);
      return calls.length === 1 ? jsonResponse({}, 401) : jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    let refreshReceivedSameFetchFn = false;
    const refreshSession: typeof refreshSessionReal = (async (_configDir, refreshFetchFn) => {
      refreshReceivedSameFetchFn = refreshFetchFn === fetchFn;
      return {
        accessToken: "at-2",
        refreshToken: "rt-2",
        userId: "user_1",
        email: "a@example.com",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      };
    }) as unknown as typeof refreshSessionReal;

    await authedFetch(tmpRoot, fetchFn, refreshSession)("https://example.invalid/thing");

    expect(refreshReceivedSameFetchFn).toBe(true);
  });
});
