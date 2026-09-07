import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAuthSession } from "../../src/auth/authStore";
import {
  HOSTED_ACCOUNTS_UNAVAILABLE_MESSAGE,
  HostedAccountsUnavailable,
  hostedAccountAccess,
  hostedCommandVisible,
  liveHostedSession,
  splashAuthItems,
} from "../../src/auth/hostedAccountAccess";

describe("hostedAccountAccess", () => {
  test("omitted bake is offered", () => {
    expect(hostedAccountAccess(undefined)).toBe("offered");
    expect(hostedAccountAccess()).toBe("offered");
  });

  test("baked false is unavailable", () => {
    expect(hostedAccountAccess(false)).toBe("unavailable");
  });

  test("baked true is offered", () => {
    expect(hostedAccountAccess(true)).toBe("offered");
  });
});

describe("splashAuthItems", () => {
  test("unavailable is Continue only", () => {
    expect(splashAuthItems("unavailable", true)).toEqual([
      { label: "Continue", action: "continue" },
    ]);
    expect(splashAuthItems("unavailable", false)).toEqual([
      { label: "Continue", action: "continue" },
    ]);
  });

  test("offered and session missing is the logged-out triple", () => {
    expect(splashAuthItems("offered", true)).toEqual([
      { label: "Log in", action: "login" },
      { label: "Sign up", action: "signup" },
      { label: "Continue without logging in", action: "continue" },
    ]);
  });

  test("offered and session present is Continue", () => {
    expect(splashAuthItems("offered", false)).toEqual([{ label: "Continue", action: "continue" }]);
  });
});

describe("hostedCommandVisible", () => {
  test("hides /login and /signup when unavailable", () => {
    expect(hostedCommandVisible("/login", "unavailable")).toBe(false);
    expect(hostedCommandVisible("/signup", "unavailable")).toBe(false);
  });

  test("keeps /logout and /setup when unavailable", () => {
    expect(hostedCommandVisible("/logout", "unavailable")).toBe(true);
    expect(hostedCommandVisible("/setup", "unavailable")).toBe(true);
  });

  test("keeps /login and /signup when offered", () => {
    expect(hostedCommandVisible("/login", "offered")).toBe(true);
    expect(hostedCommandVisible("/signup", "offered")).toBe(true);
  });
});

describe("HostedAccountsUnavailable", () => {
  test("uses the shared message and code", () => {
    const err = new HostedAccountsUnavailable();
    expect(err.message).toBe(HOSTED_ACCOUNTS_UNAVAILABLE_MESSAGE);
    expect(err.code).toBe("hosted-accounts-unavailable");
    expect(err.message).not.toMatch(/waitlist|soon|roadmap/i);
  });
});

describe("liveHostedSession", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-live-session-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("returns the file when offered", () => {
    saveAuthSession(
      {
        accessToken: "at-1",
        refreshToken: "rt-1",
        userId: "user_1",
        email: "a@example.com",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      },
      configDir,
    );
    expect(liveHostedSession(configDir, "offered")?.accessToken).toBe("at-1");
  });

  test("leftover file is inert when unavailable", () => {
    saveAuthSession(
      {
        accessToken: "at-1",
        refreshToken: "rt-1",
        userId: "user_1",
        email: "a@example.com",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      },
      configDir,
    );
    expect(liveHostedSession(configDir, "unavailable")).toBeUndefined();
  });
});
