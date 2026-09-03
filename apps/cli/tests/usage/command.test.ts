import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_FILENAME } from "../../src/auth/authStore";
import { CODEX_AUTH_FILENAME } from "../../src/auth/codexAuthStore";
import { CODEX_IGNORE_FILENAME, ignoreCodexSubscription } from "../../src/auth/codexIgnore";
import { logout } from "../../src/auth/commands";
import { XAI_AUTH_FILENAME } from "../../src/auth/xaiAuthStore";
import { runUsageCommand } from "../../src/usage/command";
import { LOGGED_OUT_USAGE } from "../../src/usage/format";
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
  requestsToday: 0,
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
  configDir = mkdtempSync(join(tmpdir(), "seri-usage-command-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("runUsageCommand", () => {
  test("logged out prints the BYOK copy and does not fetch", async () => {
    const lines: string[] = [];
    let fetched = 0;
    await runUsageCommand(configDir, {
      presenter: { message: (text) => lines.push(text) },
      fetchUsage: async () => {
        fetched += 1;
        return { status: "logged-out" };
      },
    });
    expect(lines).toEqual(LOGGED_OUT_USAGE.split("\n"));
    expect(fetched).toBe(1);
  });

  test("a fetch error throws the user-facing message", async () => {
    await expect(
      runUsageCommand(configDir, {
        fetchUsage: async () => ({
          status: "error",
          message: "Could not load hosted usage. Try again in a moment.",
        }),
      }),
    ).rejects.toThrow("Could not load hosted usage");
  });

  test("a fetched report prints the percent headline", async () => {
    const lines: string[] = [];
    await runUsageCommand(configDir, {
      presenter: { message: (text) => lines.push(text) },
      fetchUsage: async () => ({ status: "ok", report }),
    });
    expect(lines.join("\n")).toContain("Hosted  Pro");
    expect(lines.join("\n")).toContain("Included this month");
  });
});

describe("logout", () => {
  test("deletes usage-snapshot.json when present", () => {
    writeFileSync(
      join(configDir, AUTH_FILENAME),
      JSON.stringify({
        accessToken: "at",
        refreshToken: "rt",
        userId: "u",
        email: "a@b.c",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    writeUsageSnapshot(configDir, { fetchedAt: "2026-08-16T12:00:00.000Z", report });
    expect(existsSync(join(configDir, USAGE_SNAPSHOT_FILENAME))).toBe(true);

    const messages: string[] = [];
    logout(configDir, (message) => messages.push(message));

    expect(messages).toEqual(["Logged out."]);
    expect(existsSync(join(configDir, AUTH_FILENAME))).toBe(false);
    expect(existsSync(join(configDir, USAGE_SNAPSHOT_FILENAME))).toBe(false);
  });

  test("does not clear Grok, Codex ignore, or a separate Codex CLI login", () => {
    writeFileSync(
      join(configDir, AUTH_FILENAME),
      JSON.stringify({
        accessToken: "at",
        refreshToken: "rt",
        userId: "u",
        email: "a@b.c",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    writeFileSync(
      join(configDir, XAI_AUTH_FILENAME),
      JSON.stringify({ accessToken: "a", refreshToken: "r" }),
    );
    ignoreCodexSubscription(configDir);

    const originalCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), "seri-logout-codex-"));
    process.env.CODEX_HOME = codexHome;
    const codexAuth = join(codexHome, CODEX_AUTH_FILENAME);
    writeFileSync(
      codexAuth,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok", account_id: "acct" },
      }),
    );
    const beforeCodex = readFileSync(codexAuth);

    try {
      logout(configDir, () => {});
      expect(existsSync(join(configDir, AUTH_FILENAME))).toBe(false);
      expect(existsSync(join(configDir, XAI_AUTH_FILENAME))).toBe(true);
      expect(existsSync(join(configDir, CODEX_IGNORE_FILENAME))).toBe(true);
      expect(readFileSync(codexAuth)).toEqual(beforeCodex);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
