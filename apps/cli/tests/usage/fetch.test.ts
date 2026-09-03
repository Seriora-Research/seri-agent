import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_FILENAME } from "../../src/auth/authStore";
import type { refreshSession as refreshSessionReal } from "../../src/auth/refresh";
import { fetchUsageReport } from "../../src/usage/fetch";
import type { UsageReport } from "../../src/usage/report";
import { USAGE_SNAPSHOT_FILENAME, writeUsageSnapshot } from "../../src/usage/snapshot";

const report: UsageReport = {
  generatedAt: "2026-08-16T12:00:00.000Z",
  plan: "pro",
  window: {
    kind: "utc_month",
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-09-01T00:00:00.000Z",
  },
  quota: { metric: "usd", used: 1, included: 15, remaining: 14 },
  requestsToday: 1,
  dailyRequestCap: 500,
  hitAt: null,
  models: [],
  cache: {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    hitRate: 0,
    writeRate: 0,
  },
  days: [],
  sessions: [],
};

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "seri-usage-fetch-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function seedAuth(): void {
  writeFileSync(
    join(configDir, AUTH_FILENAME),
    JSON.stringify({
      accessToken: "at-1",
      refreshToken: "rt-1",
      userId: "user_1",
      email: "a@example.com",
      obtainedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

const refreshNeverCalled: typeof refreshSessionReal = (async () => {
  throw new Error("refreshSession should not have been called");
}) as unknown as typeof refreshSessionReal;

describe("fetchUsageReport", () => {
  test("logged out skips the network", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;

    const result = await fetchUsageReport(configDir, {
      fetchFn,
      refreshSession: refreshNeverCalled,
    });
    expect(result).toEqual({ status: "logged-out" });
    expect(calls).toBe(0);
  });

  test("a 200 writes a snapshot and returns ok", async () => {
    seedAuth();
    const fetchFn = (async () =>
      new Response(JSON.stringify(report), { status: 200 })) as unknown as typeof fetch;

    const result = await fetchUsageReport(configDir, {
      fetchFn,
      refreshSession: refreshNeverCalled,
      now: new Date("2026-08-16T12:00:00.000Z"),
    });
    expect(result.status).toBe("ok");
    expect(existsSync(join(configDir, USAGE_SNAPSHOT_FILENAME))).toBe(true);
  });

  test("a failed fetch with a fresh snapshot is stale; deleting the snapshot is an error", async () => {
    seedAuth();
    writeUsageSnapshot(configDir, {
      fetchedAt: "2026-08-16T11:30:00.000Z",
      report,
    });
    const fetchFn = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const now = new Date("2026-08-16T12:00:00.000Z");

    const stale = await fetchUsageReport(configDir, {
      fetchFn,
      refreshSession: refreshNeverCalled,
      now,
    });
    expect(stale.status).toBe("stale");
    if (stale.status === "stale") expect(stale.fetchedAt).toBe("2026-08-16T11:30:00.000Z");

    rmSync(join(configDir, USAGE_SNAPSHOT_FILENAME));
    const failed = await fetchUsageReport(configDir, {
      fetchFn,
      refreshSession: refreshNeverCalled,
      now,
    });
    expect(failed.status).toBe("error");
  });

  test("a snapshot older than 60 minutes is not used", async () => {
    seedAuth();
    writeUsageSnapshot(configDir, {
      fetchedAt: "2026-08-16T10:59:00.000Z",
      report,
    });
    const fetchFn = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const failed = await fetchUsageReport(configDir, {
      fetchFn,
      refreshSession: refreshNeverCalled,
      now: new Date("2026-08-16T12:00:00.000Z"),
    });
    expect(failed.status).toBe("error");
  });

  test("a snapshot dated in the future is not used", async () => {
    seedAuth();
    writeUsageSnapshot(configDir, {
      fetchedAt: "2026-08-16T13:00:00.000Z",
      report,
    });
    const fetchFn = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const failed = await fetchUsageReport(configDir, {
      fetchFn,
      refreshSession: refreshNeverCalled,
      now: new Date("2026-08-16T12:00:00.000Z"),
    });
    expect(failed.status).toBe("error");
  });

  test("a 200 still returns ok when the snapshot cannot be written", async () => {
    seedAuth();
    mkdirSync(join(configDir, USAGE_SNAPSHOT_FILENAME));
    const fetchFn = (async () =>
      new Response(JSON.stringify(report), { status: 200 })) as unknown as typeof fetch;

    const result = await fetchUsageReport(configDir, {
      fetchFn,
      refreshSession: refreshNeverCalled,
      now: new Date("2026-08-16T12:00:00.000Z"),
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.report).toEqual(report);
  });
});
