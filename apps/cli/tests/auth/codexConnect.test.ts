import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_SERI_AUTH_FILENAME,
  hasSeriCodexSubscription,
  loadCodexSubscription,
} from "../../src/auth/codexAuthStore";
import {
  CODEX_BORROWED_CLIENT_WARNING,
  connectCodex,
  disconnectCodex,
} from "../../src/auth/codexConnect";
import { CODEX_IGNORE_FILENAME } from "../../src/auth/codexIgnore";
import type { CallbackServer } from "../../src/mcp/loopback";

function jwtWithAccount(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      exp: 1_700_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `aaa.${payload}.sig`;
}

let dir: string;
let leftoverHome: string;
const originalCodexHome = process.env.CODEX_HOME;
const originalPath = process.env.PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seri-codex-connect-"));
  leftoverHome = mkdtempSync(join(tmpdir(), "seri-codex-leftover-"));
  process.env.CODEX_HOME = leftoverHome;
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(dir, { recursive: true, force: true });
  rmSync(leftoverHome, { recursive: true, force: true });
});

function fakeCallback(code: string): CallbackServer {
  return {
    redirectUri: "http://localhost:1455/auth/callback",
    waitForCallback: async () => ({ kind: "code", code }),
    close: () => {},
  };
}

describe("CODEX_BORROWED_CLIENT_WARNING", () => {
  test("names Codex CLI and that seri does not own the client id", () => {
    expect(CODEX_BORROWED_CLIENT_WARNING).toContain("Codex CLI");
    expect(CODEX_BORROWED_CLIENT_WARNING).toContain("does not own");
  });
});

describe("connectCodex", () => {
  test("opens the browser after the authorize URL is built, then stores the seri file", async () => {
    const events: string[] = [];
    process.env.PATH = "";
    await connectCodex(dir, {
      startCallback: async () => {
        events.push("listen");
        return fakeCallback("code-1");
      },
      openBrowser: (url) => {
        events.push(`browser:${url}`);
      },
      exchangeCode: async () => {
        events.push("exchange");
        return { accessToken: jwtWithAccount("acct-7"), refreshToken: "r", expiresIn: 3600 };
      },
      onAuthorizeUrl: (url) => {
        events.push(`url:${url.includes("originator=seri") ? "seri" : "other"}`);
      },
      onMessage: () => {},
    });

    expect(events[0]).toBe("listen");
    expect(events.some((event) => event.startsWith("browser:"))).toBe(true);
    expect(events).toContain("url:seri");
    expect(events).toContain("exchange");
    expect(hasSeriCodexSubscription(dir)).toBe(true);
    expect(loadCodexSubscription(dir)?.accountId).toBe("acct-7");
    expect(existsSync(join(leftoverHome, "auth.json"))).toBe(false);
  });

  test("connect works with PATH empty of codex", async () => {
    process.env.PATH = "";
    await connectCodex(dir, {
      startCallback: async () => fakeCallback("code-1"),
      openBrowser: () => {},
      exchangeCode: async () => ({
        accessToken: jwtWithAccount("acct-1"),
        refreshToken: "r",
      }),
      onMessage: () => {},
    });
    expect(hasSeriCodexSubscription(dir)).toBe(true);
  });
});

describe("disconnectCodex", () => {
  test("unlinks the seri file and leaves ~/.codex/auth.json untouched", () => {
    writeFileSync(
      join(dir, CODEX_SERI_AUTH_FILENAME),
      JSON.stringify({
        accessToken: "a",
        refreshToken: "r",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const leftover = join(leftoverHome, "auth.json");
    writeFileSync(
      leftover,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "tok", account_id: "acct" },
      }),
    );
    const before = require("node:fs").readFileSync(leftover);
    disconnectCodex(dir, () => {});
    expect(existsSync(join(dir, CODEX_SERI_AUTH_FILENAME))).toBe(false);
    expect(require("node:fs").readFileSync(leftover)).toEqual(before);
    expect(existsSync(join(dir, CODEX_IGNORE_FILENAME))).toBe(true);
  });
});
