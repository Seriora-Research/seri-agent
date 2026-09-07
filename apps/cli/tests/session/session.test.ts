import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldsCase } from "../../src/caseFold";
import { SessionDatabase } from "../../src/session/database";
import {
  findMostRecentSession,
  findMostRecentSessionForCwd,
  loadSession,
  type SessionState,
  saveSession,
} from "../../src/session/session";

let configDir: string;
let sessionsDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "seri-session-test-"));
  sessionsDir = join(configDir, "sessions");
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("SQLite session persistence helpers", () => {
  test("round-trips every header field and mixed message content exactly", () => {
    const state: SessionState = {
      id: "abc123",
      cwd: "C:\\repo",
      systemPrompt: "You are seri, a coding agent.",
      permissionMode: "approve-each",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      reasoningEffort: "high",
      messages: [
        { role: "user", content: "do the thing" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "on it" },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "bash",
              input: { command: "pwd" },
            },
          ],
        },
        { role: "tool", content: [{ type: "tool-result", output: { type: "text", value: "ok" } }] },
      ],
    };

    saveSession(state, sessionsDir);

    expect(loadSession("abc123", sessionsDir)).toEqual(state);
    expect(existsSync(join(configDir, "seri.db"))).toBe(true);
    expect(existsSync(join(sessionsDir, "abc123.jsonl"))).toBe(false);
  });

  test("appends messages, updates only the header, and shrinks to the supplied state", () => {
    const initial: SessionState = {
      id: "changes",
      cwd: "/old",
      systemPrompt: "system",
      permissionMode: "auto",
      messages: [{ n: 1 }],
    };
    saveSession(initial, sessionsDir);
    saveSession({ ...initial, messages: [...initial.messages, { n: 2 }, { n: 3 }] }, sessionsDir);
    expect(loadSession("changes", sessionsDir).messages).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    saveSession(
      {
        ...initial,
        cwd: "/new",
        permissionMode: "approve-each",
        messages: [{ n: 1 }, { n: 2 }, { n: 3 }],
      },
      sessionsDir,
    );
    expect(loadSession("changes", sessionsDir)).toMatchObject({
      cwd: "/new",
      permissionMode: "approve-each",
      messages: [{ n: 1 }, { n: 2 }, { n: 3 }],
    });

    const shrunk: SessionState = {
      ...initial,
      cwd: "/new",
      permissionMode: "approve-each",
      messages: [{ n: 1 }],
    };
    saveSession(shrunk, sessionsDir);
    expect(loadSession("changes", sessionsDir)).toEqual(shrunk);
  });

  test("throws the existing missing-session error", () => {
    expect(() => loadSession("missing", sessionsDir)).toThrow(
      `Session "missing" not found in ${sessionsDir}`,
    );
  });

  test("imports a torn legacy session and reports the dropped tail", () => {
    const header = { id: "torn", cwd: ".", systemPrompt: "", permissionMode: "auto" as const };
    mkdirSync(sessionsDir);
    writeFileSync(
      join(sessionsDir, "torn.jsonl"),
      `${JSON.stringify(header)}\n${JSON.stringify({ n: 1 })}\n{"n":2`,
    );
    let truncated = 0;

    const loaded = loadSession("torn", sessionsDir, () => truncated++);

    expect(loaded.messages).toEqual([{ n: 1 }]);
    expect(truncated).toBe(1);
  });
});

describe("recent SQLite sessions", () => {
  test("returns the most recently saved session", () => {
    saveSession(
      { id: "first", cwd: "/a", systemPrompt: "", permissionMode: "auto", messages: [] },
      sessionsDir,
    );
    saveSession(
      { id: "second", cwd: "/b", systemPrompt: "", permissionMode: "auto", messages: [] },
      sessionsDir,
    );

    expect(findMostRecentSession(sessionsDir)).toBe("second");
  });

  test("returns the newest session for one cwd", () => {
    saveSession(
      { id: "here-1", cwd: "/project/a", systemPrompt: "", permissionMode: "auto", messages: [] },
      sessionsDir,
    );
    saveSession(
      {
        id: "elsewhere",
        cwd: "/project/b",
        systemPrompt: "",
        permissionMode: "auto",
        messages: [],
      },
      sessionsDir,
    );
    saveSession(
      { id: "here-2", cwd: "/project/a", systemPrompt: "", permissionMode: "auto", messages: [] },
      sessionsDir,
    );

    expect(findMostRecentSessionForCwd(sessionsDir, "/project/a")).toBe("here-2");
  });

  test("returns undefined when the database has no matching session", () => {
    expect(findMostRecentSession(sessionsDir)).toBeUndefined();
    expect(findMostRecentSessionForCwd(sessionsDir, "/project/a")).toBeUndefined();
  });

  (foldsCase() ? test : test.skip)(
    "matches cwd case-insensitively on a case-folding filesystem",
    () => {
      saveSession(
        {
          id: "cased",
          cwd: "/Project/Cased",
          systemPrompt: "",
          permissionMode: "auto",
          messages: [],
        },
        sessionsDir,
      );

      expect(findMostRecentSessionForCwd(sessionsDir, "/project/cased")).toBe("cased");
    },
  );
});



test("separate profile roots never see each other's sessions", () => {
  const parent = mkdtempSync(join(tmpdir(), "seri-profile-session-test-"));
  const first = join(parent, "first", "sessions");
  const second = join(parent, "second", "sessions");
  try {
    saveSession(
      { id: "only-first", cwd: ".", systemPrompt: "", permissionMode: "auto", messages: [] },
      first,
    );

    expect(findMostRecentSession(second)).toBeUndefined();
    expect(() => loadSession("only-first", second)).toThrow(
      `Session "only-first" not found in ${second}`,
    );
    expect(readdirSync(join(parent, "first"))).toContain("seri.db");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 20_000);

describe("held SessionDatabase reuse", () => {
  test("saveSession with a held database does not close it; without one it does", () => {
    const database = new SessionDatabase(configDir);
    const originalClose = SessionDatabase.prototype.close;
    let closes = 0;
    SessionDatabase.prototype.close = function (this: SessionDatabase) {
      closes++;
      return originalClose.call(this);
    };
    try {
      const state: SessionState = {
        id: "held",
        cwd: "/repo",
        systemPrompt: "system",
        permissionMode: "approve-each",
        messages: [{ n: 1 }],
      };
      saveSession(state, sessionsDir, database);
      saveSession({ ...state, messages: [{ n: 1 }, { n: 2 }] }, sessionsDir, database);
      expect(closes).toBe(0);
      expect(loadSession("held", sessionsDir, () => {}, database).messages).toEqual([
        { n: 1 },
        { n: 2 },
      ]);

      const beforeUnheld = closes;
      saveSession({ ...state, id: "unheld", messages: [] }, sessionsDir);
      expect(closes).toBeGreaterThan(beforeUnheld);
    } finally {
      SessionDatabase.prototype.close = originalClose;
      database.close();
    }
  });

  test("saveSession with a held database does not import legacy sessions again", () => {
    const database = new SessionDatabase(configDir);
    const originalImport = SessionDatabase.prototype.importLegacySessions;
    let imports = 0;
    SessionDatabase.prototype.importLegacySessions = function (this: SessionDatabase, dir: string) {
      imports++;
      return originalImport.call(this, dir);
    };
    try {
      database.importLegacySessions(sessionsDir);
      expect(imports).toBe(1);
      saveSession(
        { id: "held", cwd: "/repo", systemPrompt: "", permissionMode: "auto", messages: [] },
        sessionsDir,
        database,
      );
      expect(imports).toBe(1);

      saveSession(
        { id: "unheld", cwd: "/repo", systemPrompt: "", permissionMode: "auto", messages: [] },
        sessionsDir,
      );
      expect(imports).toBeGreaterThan(1);
    } finally {
      SessionDatabase.prototype.importLegacySessions = originalImport;
      database.close();
    }
  });
});
