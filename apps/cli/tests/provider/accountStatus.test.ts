import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_FILENAME } from "../../src/auth/authStore";
import type { refreshSession as refreshSessionReal } from "../../src/auth/refresh";
import { fetchAccountPlan, loadCachedAccountPlan } from "../../src/provider/accountStatus";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-account-status-test-"));
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  delete process.env.HOME;
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

describe("fetchAccountPlan — not logged in", () => {
  test("returns null with zero fetchFn calls when no auth.json exists", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      throw new Error("fetchFn should not have been called");
    }) as unknown as typeof fetch;

    const plan = await fetchAccountPlan(tmpRoot, { fetchFn, refreshSession: refreshNeverCalled });

    expect(plan).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("fetchAccountPlan — success", () => {
  test("a 200 response's plan is returned", async () => {
    seedAuthJson(tmpRoot);
    const fetchFn = (async () => jsonResponse({ plan: "pro" })) as unknown as typeof fetch;

    const plan = await fetchAccountPlan(tmpRoot, { fetchFn, refreshSession: refreshNeverCalled });

    expect(plan).toBe("pro");
    expect(loadCachedAccountPlan(tmpRoot)).toBe("pro");
  });
});

describe("fetchAccountPlan — 401 retry", () => {
  test("a 401 then 200 triggers the shared refresh-and-retry path once, succeeding on retry", async () => {
    seedAuthJson(tmpRoot);
    const calls: Headers[] = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Headers(init?.headers));
      return calls.length === 1
        ? jsonResponse({ code: "token_invalid" }, 401)
        : jsonResponse({ plan: "max" });
    }) as unknown as typeof fetch;

    const plan = await fetchAccountPlan(tmpRoot, { fetchFn, refreshSession: fakeRefresh("at-2") });

    expect(plan).toBe("max");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.get("Authorization")).toBe("Bearer at-1");
    expect(calls[1]?.get("Authorization")).toBe("Bearer at-2");
  });
});

describe("fetchAccountPlan — failure paths fail closed to null", () => {
  test("a network throw returns null", async () => {
    seedAuthJson(tmpRoot);
    const fetchFn = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    const plan = await fetchAccountPlan(tmpRoot, { fetchFn, refreshSession: refreshNeverCalled });

    expect(plan).toBeNull();
  });

  test("a failed fetch returns the last cached plan instead of forgetting a known login", async () => {
    seedAuthJson(tmpRoot);
    writeFileSync(join(tmpRoot, "account-plan"), "pro\n");
    const fetchFn = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    const plan = await fetchAccountPlan(tmpRoot, { fetchFn, refreshSession: refreshNeverCalled });

    expect(plan).toBe("pro");
  });

  test("a non-2xx response (e.g. 503) returns null", async () => {
    seedAuthJson(tmpRoot);
    const fetchFn = (async () =>
      jsonResponse({ code: "entitlement_error" }, 503)) as unknown as typeof fetch;

    const plan = await fetchAccountPlan(tmpRoot, { fetchFn, refreshSession: refreshNeverCalled });

    expect(plan).toBeNull();
  });

  test("a non-2xx response still returns the last cached plan", async () => {
    seedAuthJson(tmpRoot);
    writeFileSync(join(tmpRoot, "account-plan"), "max\n");
    const fetchFn = (async () =>
      jsonResponse({ code: "entitlement_error" }, 503)) as unknown as typeof fetch;

    const plan = await fetchAccountPlan(tmpRoot, { fetchFn, refreshSession: refreshNeverCalled });

    expect(plan).toBe("max");
  });

  test("a malformed JSON body returns null", async () => {
    seedAuthJson(tmpRoot);
    const fetchFn = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const plan = await fetchAccountPlan(tmpRoot, { fetchFn, refreshSession: refreshNeverCalled });

    expect(plan).toBeNull();
  });

  test("a request that never responds still returns null, bounded by the deadline", async () => {
    seedAuthJson(tmpRoot);
    const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      })) as unknown as typeof fetch;

    const start = Date.now();
    const plan = await fetchAccountPlan(tmpRoot, {
      fetchFn,
      refreshSession: refreshNeverCalled,
      timeoutMs: 50,
    });
    const elapsedMs = Date.now() - start;

    expect(plan).toBeNull();
    expect(elapsedMs).toBeLessThan(2000);
  });
});
