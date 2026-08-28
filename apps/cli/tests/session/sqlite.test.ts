import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATABASE_FILENAME,
  SessionDatabase,
  configDirForStore,
  type SessionSearchResult,
} from "../../src/session/database";
import { exportSessionsToJsonl } from "../../src/session/export";
import type { SessionState } from "../../src/session/session";

let configDir: string;
let sessionsDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "seri-sqlite-test-"));
  sessionsDir = join(configDir, "sessions");
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function state(id: string, messages: unknown[], cwd = "/repo"): SessionState {
  return {
    id,
    cwd,
    systemPrompt: "system",
    permissionMode: "approve-each",
    model: "gpt-5",
    provider: "openai",
    reasoningEffort: "high",
    messages,
  };
}

function withDatabase<T>(fn: (database: SessionDatabase) => T): T {
  const database = new SessionDatabase(configDir);
  try {
    return fn(database);
  } finally {
    database.close();
  }
}

describe("SessionDatabase", () => {
  test("enables required pragmas, applies numbered migrations, and rejects a newer schema", () => {
    const pragmas = withDatabase((database) => database.getPragmas());
    expect(pragmas.foreignKeys).toBe(1);
    expect(pragmas.journalMode).toBe("wal");
    expect(pragmas.busyTimeout).toBeGreaterThan(0);
    expect(pragmas.userVersion).toBe(3);
    const raw = new Database(join(configDir, DATABASE_FILENAME));
    const version = (raw.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    expect(version).toBeGreaterThan(0);
    raw.exec(`PRAGMA user_version = ${version + 1}`);
    raw.close();

    expect(() => new SessionDatabase(configDir)).toThrow("newer than this seri binary");
    // Windows CI: first SessionDatabase open + pragma round-trip was 3373ms on the same job.
  }, 20_000);

  test("append and header updates retain message row ids while shrink removes only the tail", () => {
    withDatabase((database) => database.saveSession(state("changes", [{ n: 1 }])));
    const first = new Database(join(configDir, DATABASE_FILENAME));
    const firstId = (
      first.query("SELECT id FROM messages WHERE session_id = 'changes'").get() as {
        id: number;
      }
    ).id;
    first.close();

    withDatabase((database) => {
      database.saveSession(state("changes", [{ n: 1 }, { n: 2 }, { n: 3 }]));
      database.saveSession({
        ...state("changes", [{ n: 1 }, { n: 2 }, { n: 3 }]),
        permissionMode: "auto",
      });
      database.saveSession(state("changes", [{ n: 1 }]));
    });

    const raw = new Database(join(configDir, DATABASE_FILENAME));
    expect(raw.query("SELECT id, seq FROM messages WHERE session_id = 'changes'").all()).toEqual([
      { id: firstId, seq: 0 },
    ]);
    raw.close();
    expect(withDatabase((database) => database.loadSession("changes"))).toEqual(
      state("changes", [{ n: 1 }]),
    );
  });

  test("search indexes only user and assistant text and keeps FTS triggers aligned", () => {
    withDatabase((database) => {
      database.saveSession(
        state("searchable", [
          { role: "user", content: "remember cobalt platypus" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "needle alpha" },
              { type: "tool-call", toolName: "bash", input: { secret: "toolarg-only" } },
            ],
          },
          { role: "tool", content: "toolresult-only" },
        ]),
      );
      expect(database.searchSessions("cobalt")).toMatchObject([
        { sessionId: "searchable", messageIndex: 0 },
      ]);
      expect(database.searchSessions("needle:(alpha)")).toHaveLength(1);
      expect(database.searchSessions("toolarg-only")).toEqual([]);
      expect(database.searchSessions("toolresult-only")).toEqual([]);

      database.saveSession(
        state("searchable", [
          { role: "user", content: "replacement phrase" },
          { role: "assistant", content: "needle alpha" },
        ]),
      );
      expect(database.searchSessions("cobalt")).toEqual([]);
      expect(database.searchSessions("replacement")).toHaveLength(1);
      database.saveSession(state("searchable", [{ role: "user", content: "replacement phrase" }]));
      expect(database.searchSessions("needle")).toEqual([]);
    });
  });

  test("search is bounded to 50 and supports cwd and session filters", () => {
    withDatabase((database) => {
      database.saveSession(
        state(
          "many",
          Array.from({ length: 55 }, (_, index) => ({
            role: "user",
            content: `bounded-token ${index}`,
          })),
          "/one",
        ),
      );
      database.saveSession(
        state("other", [{ role: "assistant", content: "bounded-token" }], "/two"),
      );

      expect(database.searchSessions("bounded-token", { limit: 500 })).toHaveLength(50);
      expect(database.searchSessions("bounded-token", { cwd: "/two" })).toMatchObject([
        { sessionId: "other" },
      ]);
      expect(database.searchSessions("bounded-token", { sessionId: "other" })).toMatchObject([
        { sessionId: "other" },
      ]);
    });
  });
});

describe("legacy session migration", () => {
  test("imports clean and torn files, isolates corruption, preserves bytes, and is idempotent", () => {
    mkdirSync(sessionsDir);
    const cleanPath = join(sessionsDir, "clean.jsonl");
    const tornPath = join(sessionsDir, "torn.jsonl");
    const corruptPath = join(sessionsDir, "corrupt.jsonl");
    const header = (id: string) => ({
      id,
      cwd: "/legacy",
      systemPrompt: "",
      permissionMode: "auto",
    });
    writeFileSync(
      cleanPath,
      `${JSON.stringify(header("clean"))}\n${JSON.stringify({ role: "user", content: "clean fact" })}\n`,
    );
    writeFileSync(
      tornPath,
      `${JSON.stringify(header("torn"))}\n${JSON.stringify({ role: "assistant", content: "valid prefix" })}\n{"role":"user"`,
    );
    writeFileSync(
      corruptPath,
      `${JSON.stringify(header("corrupt"))}\n${JSON.stringify({ role: "user", content: "before" })}\nnot-json\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const snapshots = new Map(
      [cleanPath, tornPath, corruptPath].map((path) => [path, readFileSync(path)]),
    );

    withDatabase((database) => {
      const first = database.importLegacySessions(sessionsDir);
      expect(first.truncatedSessionIds).toEqual(["torn"]);
      expect(database.loadSession("clean")?.messages).toHaveLength(1);
      expect(database.loadSession("torn")?.messages).toEqual([
        { role: "assistant", content: "valid prefix" },
      ]);
      expect(database.loadSession("corrupt")).toBeUndefined();
      expect(database.searchSessions("clean")).toHaveLength(1);
      database.importLegacySessions(sessionsDir);
    });

    const raw = new Database(join(configDir, DATABASE_FILENAME));
    expect(
      raw
        .query("SELECT COUNT(*) AS count FROM messages WHERE session_id IN ('clean', 'torn')")
        .get(),
    ).toEqual({ count: 2 });
    const failure = raw
      .query("SELECT error FROM legacy_imports WHERE path = ?")
      .get(corruptPath) as { error: string };
    expect(failure.error.length).toBeGreaterThan(0);
    raw.close();
    for (const [path, snapshot] of snapshots) expect(readFileSync(path)).toEqual(snapshot);
  });
});

test("SQLite sessions export as legacy JSONL without changing the database", () => {
  withDatabase((database) =>
    database.saveSession(state("exported", [{ role: "user", content: "hi" }])),
  );
  const outputDir = join(configDir, "rollback");

  const paths = exportSessionsToJsonl(configDir, outputDir);

  expect(paths).toEqual([join(outputDir, "exported.jsonl")]);
  const lines = readFileSync(paths[0]!, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(lines).toEqual([
    {
      id: "exported",
      cwd: "/repo",
      systemPrompt: "system",
      permissionMode: "approve-each",
      model: "gpt-5",
      provider: "openai",
      reasoningEffort: "high",
    },
    { role: "user", content: "hi" },
  ]);
  expect(withDatabase((database) => database.loadSession("exported"))).toEqual(
    state("exported", [{ role: "user", content: "hi" }]),
  );
});

test("search results are scoped to the database for one active profile", () => {
  const otherConfig = mkdtempSync(join(tmpdir(), "seri-sqlite-other-profile-"));
  try {
    withDatabase((database) =>
      database.saveSession(state("first-profile", [{ role: "user", content: "isolated-keyword" }])),
    );
    const other = new SessionDatabase(otherConfig);
    try {
      other.saveSession(state("second-profile", [{ role: "user", content: "different text" }]));
      expect(other.searchSessions("isolated-keyword")).toEqual([] as SessionSearchResult[]);
    } finally {
      other.close();
    }
  } finally {
    rmSync(otherConfig, { recursive: true, force: true });
  }
});

test("configDirForStore peels a layout leaf and leaves an injected store directory intact", () => {
  const profile = join(tmpdir(), "seri-profile-layout");
  expect(configDirForStore(join(profile, "sessions"), "sessions")).toBe(profile);
  expect(configDirForStore(join(profile, "trajectories"), "trajectories")).toBe(profile);
  const injected = join(tmpdir(), "seri-cli-test-sessions-abc");
  expect(configDirForStore(injected, "sessions")).toBe(injected);
});
