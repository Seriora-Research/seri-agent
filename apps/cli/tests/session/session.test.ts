import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMostRecentSession, loadSession, saveSession, type SessionState } from "../../src/session/session";

let sessionsDir: string;

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "seri-session-test-"));
});

afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe("saveSession / loadSession", () => {
  test("round-trips a session exactly", () => {
    const state: SessionState = {
      id: "abc123",
      cwd: "C:\\repo",
      systemPrompt: "You are seri, a coding agent.",
      permissionMode: "approve-each",
      messages: [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: "on it" },
        { role: "tool", content: { name: "bash", result: "ok" } },
      ],
    };

    saveSession(state, sessionsDir);

    expect(loadSession("abc123", sessionsDir)).toEqual(state);
  });

  test("creates sessionsDir if it doesn't exist yet", () => {
    const freshDir = join(sessionsDir, "nested", "sessions");
    const state: SessionState = { id: "s1", cwd: ".", systemPrompt: "", permissionMode: "auto", messages: [] };

    saveSession(state, freshDir);

    expect(loadSession("s1", freshDir)).toEqual(state);
  });

  test("loadSession throws a clear error for a missing id", () => {
    expect(() => loadSession("missing", sessionsDir)).toThrow(`Session "missing" not found in ${sessionsDir}`);
  });
});

describe("findMostRecentSession", () => {
  test("returns the id of the most recently modified session", () => {
    saveSession({ id: "first", cwd: ".", systemPrompt: "", permissionMode: "auto", messages: [] }, sessionsDir);
    saveSession({ id: "second", cwd: ".", systemPrompt: "", permissionMode: "auto", messages: [] }, sessionsDir);
    saveSession({ id: "third", cwd: ".", systemPrompt: "", permissionMode: "auto", messages: [] }, sessionsDir);

    // Explicit mtimes rather than relying on real-time gaps between writes, which can be
    // too small to distinguish on a fast filesystem.
    const base = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(sessionsDir, "first.json"), base, base);
    utimesSync(join(sessionsDir, "second.json"), new Date(base.getTime() + 60_000), new Date(base.getTime() + 60_000));
    utimesSync(join(sessionsDir, "third.json"), new Date(base.getTime() + 30_000), new Date(base.getTime() + 30_000));

    expect(findMostRecentSession(sessionsDir)).toBe("second");
  });

  test("returns undefined for an empty directory", () => {
    expect(findMostRecentSession(sessionsDir)).toBeUndefined();
  });

  test("returns undefined for a non-existent directory", () => {
    expect(findMostRecentSession(join(sessionsDir, "does-not-exist"))).toBeUndefined();
  });
});
