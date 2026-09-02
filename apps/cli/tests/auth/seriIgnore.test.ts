import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAuthSession } from "../../src/auth/authStore";
import {
  SERI_IGNORE_FILENAME,
  clearSeriIgnore,
  disconnectSeri,
  effectiveHostedPlan,
  hostedPlanUsable,
  ignoreSeriPlan,
  isSeriIgnored,
  reconnectSeri,
} from "../../src/auth/seriIgnore";

describe("seriIgnore", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-ignore-cfg-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("a missing file is not ignored", () => {
    expect(isSeriIgnored(configDir)).toBe(false);
  });

  test("writing the flag makes the profile ignore the plan", () => {
    ignoreSeriPlan(configDir);
    expect(existsSync(join(configDir, SERI_IGNORE_FILENAME))).toBe(true);
    expect(isSeriIgnored(configDir)).toBe(true);
  });

  test("clearing the flag restores the default", () => {
    ignoreSeriPlan(configDir);
    clearSeriIgnore(configDir);
    expect(isSeriIgnored(configDir)).toBe(false);
    expect(existsSync(join(configDir, SERI_IGNORE_FILENAME))).toBe(false);
  });

  test("clearing when the file is missing is not an error", () => {
    expect(() => clearSeriIgnore(configDir)).not.toThrow();
  });

  test("hostedPlanUsable is login plus not-ignored", () => {
    expect(hostedPlanUsable(configDir)).toBe(false);
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
    expect(hostedPlanUsable(configDir)).toBe(true);
    ignoreSeriPlan(configDir);
    expect(hostedPlanUsable(configDir)).toBe(false);
  });

  test("effectiveHostedPlan drops a fetched plan when ignored", () => {
    expect(effectiveHostedPlan(configDir, "pro")).toBe("pro");
    ignoreSeriPlan(configDir);
    expect(effectiveHostedPlan(configDir, "pro")).toBeNull();
    expect(effectiveHostedPlan(configDir, null)).toBeNull();
  });

  test("disconnectSeri writes the flag and does not require a login", () => {
    const messages: string[] = [];
    disconnectSeri(configDir, (message) => messages.push(message));
    expect(isSeriIgnored(configDir)).toBe(true);
    expect(messages.some((line) => /stay logged in/i.test(line))).toBe(true);
  });

  test("reconnectSeri clears the ignore", () => {
    ignoreSeriPlan(configDir);
    const messages: string[] = [];
    reconnectSeri(configDir, (message) => messages.push(message));
    expect(isSeriIgnored(configDir)).toBe(false);
    expect(messages.length).toBeGreaterThan(0);
  });
});
