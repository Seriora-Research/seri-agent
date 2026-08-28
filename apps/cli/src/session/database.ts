import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModelProvider } from "@seri/model-catalog";
import { ensureOwnerOnlyDir } from "../atomicWriteFile";
import type { PermissionMode } from "../gate/gate";
import type { SessionState } from "./session";

export const DATABASE_FILENAME = "seri.db";
const CURRENT_SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        reasoning_effort TEXT,
        updated_at_ms INTEGER NOT NULL,
        archivist_cursor INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        search_text TEXT,
        UNIQUE(session_id, seq)
      );

      CREATE VIRTUAL TABLE session_fts USING fts5(
        search_text,
        content = 'messages',
        content_rowid = 'id',
        tokenize = 'unicode61'
      );

      CREATE TRIGGER messages_ai AFTER INSERT ON messages
      WHEN new.search_text IS NOT NULL BEGIN
        INSERT INTO session_fts(rowid, search_text) VALUES (new.id, new.search_text);
      END;

      CREATE TRIGGER messages_ad AFTER DELETE ON messages
      WHEN old.search_text IS NOT NULL BEGIN
        INSERT INTO session_fts(session_fts, rowid, search_text)
        VALUES ('delete', old.id, old.search_text);
      END;

      CREATE TRIGGER messages_au AFTER UPDATE ON messages
      WHEN old.search_text IS NOT NULL OR new.search_text IS NOT NULL BEGIN
        INSERT INTO session_fts(session_fts, rowid, search_text)
        SELECT 'delete', old.id, old.search_text WHERE old.search_text IS NOT NULL;
        INSERT INTO session_fts(rowid, search_text)
        SELECT new.id, new.search_text WHERE new.search_text IS NOT NULL;
      END;

      CREATE TABLE legacy_imports (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        error TEXT
      );
    `,
  },
] as const;

type SessionRow = {
  id: string;
  cwd: string;
  system_prompt: string;
  permission_mode: PermissionMode;
  model: string | null;
  provider: ModelProvider | null;
  reasoning_effort: string | null;
  updated_at_ms: number;
};

type MessageRow = {
  id: number;
  seq: number;
  json: string;
};

type LegacyImportRow = {
  size: number;
  mtime_ms: number;
};

export type SessionSearchOptions = {
  cwd?: string;
  sessionId?: string;
  limit?: number;
};

export type SessionSearchResult = {
  sessionId: string;
  messageIndex: number;
  text: string;
  cwd: string;
};

export type LegacySessionImportResult = {
  truncatedSessionIds: string[];
  failedPaths: string[];
};

function textFromMessage(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record.role !== "user" && record.role !== "assistant") return null;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return null;
  const text = record.content
    .flatMap((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string"
      ) {
        return [(part as Record<string, unknown>).text as string];
      }
      return [];
    })
    .join("\n");
  return text.length > 0 ? text : null;
}

function ftsQuery(input: string): string | undefined {
  const terms = input.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function parseLegacySession(path: string): {
  state: SessionState;
  truncated: boolean;
} {
  const raw = readFileSync(path, "utf8");
  const parts = raw.split("\n");
  const endedWithNewline = parts.at(-1) === "";
  if (endedWithNewline) parts.pop();
  if (parts.length === 0) throw new Error("session file is empty");

  const header = JSON.parse(parts[0]!) as Omit<SessionState, "messages">;
  if (
    typeof header.id !== "string" ||
    typeof header.cwd !== "string" ||
    typeof header.systemPrompt !== "string" ||
    typeof header.permissionMode !== "string"
  ) {
    throw new Error("session header is invalid");
  }

  const messages: unknown[] = [];
  let truncated = false;
  for (let index = 1; index < parts.length; index++) {
    try {
      messages.push(JSON.parse(parts[index]!));
    } catch (error) {
      if (index !== parts.length - 1 || endedWithNewline) throw error;
      truncated = true;
    }
  }
  return { state: { ...header, messages }, truncated };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionDatabase {
  private readonly database: Database;

  constructor(readonly configDir: string) {
    ensureOwnerOnlyDir(configDir);
    this.database = new Database(join(configDir, DATABASE_FILENAME), { create: true });
    try {
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      this.migrate();
      this.database
        .query("SELECT rowid FROM session_fts WHERE session_fts MATCH ? LIMIT 0")
        .all("fts-probe");
      if (this.database.query("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("SQLite foreign-key integrity check failed");
      }
      this.database
        .query("INSERT INTO session_fts(session_fts, rank) VALUES (?, ?)")
        .run("integrity-check", 1);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  getPragmas(): { foreignKeys: number; journalMode: string; busyTimeout: number; userVersion: number } {
    return {
      foreignKeys: (
        this.database.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
      ).foreign_keys,
      journalMode: (
        this.database.query("PRAGMA journal_mode").get() as { journal_mode: string }
      ).journal_mode,
      busyTimeout: (
        this.database.query("PRAGMA busy_timeout").get() as { timeout: number }
      ).timeout,
      userVersion: (
        this.database.query("PRAGMA user_version").get() as { user_version: number }
      ).user_version,
    };
  }

  saveSession(state: SessionState): void {
    this.database.transaction(() => this.writeSession(state))();
  }

  loadSession<TMessage = unknown>(id: string): SessionState<TMessage> | undefined {
    const header = this.database.query("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | null;
    if (header === null) return undefined;
    const messages = this.database
      .query("SELECT json FROM messages WHERE session_id = ? ORDER BY seq")
      .all(id) as { json: string }[];
    return {
      id: header.id,
      cwd: header.cwd,
      systemPrompt: header.system_prompt,
      permissionMode: header.permission_mode,
      ...(header.model !== null ? { model: header.model } : {}),
      ...(header.provider !== null ? { provider: header.provider } : {}),
      ...(header.reasoning_effort !== null ? { reasoningEffort: header.reasoning_effort } : {}),
      messages: messages.map((message) => JSON.parse(message.json) as TMessage),
    };
  }

  listSessionsByRecent(): { id: string; cwd: string }[] {
    return this.database
      .query("SELECT id, cwd FROM sessions ORDER BY updated_at_ms DESC, rowid DESC")
      .all() as { id: string; cwd: string }[];
  }

  listSessionIds(): string[] {
    return (
      this.database.query("SELECT id FROM sessions ORDER BY id").all() as { id: string }[]
    ).map((row) => row.id);
  }

  searchSessions(query: string, options: SessionSearchOptions = {}): SessionSearchResult[] {
    const match = ftsQuery(query);
    if (match === undefined) return [];
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 50)));
    const clauses = ["session_fts MATCH ?"];
    const bindings: (string | number)[] = [match];
    if (options.cwd !== undefined) {
      clauses.push("sessions.cwd = ?");
      bindings.push(options.cwd);
    }
    if (options.sessionId !== undefined) {
      clauses.push("messages.session_id = ?");
      bindings.push(options.sessionId);
    }
    bindings.push(limit);
    return this.database
      .query(
        `SELECT messages.session_id AS sessionId, messages.seq AS messageIndex,
                messages.search_text AS text, sessions.cwd AS cwd
           FROM session_fts
           JOIN messages ON messages.id = session_fts.rowid
           JOIN sessions ON sessions.id = messages.session_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY sessions.updated_at_ms DESC, messages.seq
          LIMIT ?`,
      )
      .all(...bindings) as SessionSearchResult[];
  }

  importLegacySessions(sessionsDir: string): LegacySessionImportResult {
    const result: LegacySessionImportResult = { truncatedSessionIds: [], failedPaths: [] };
    if (!existsSync(sessionsDir)) return result;
    for (const name of readdirSync(sessionsDir).filter((entry) => entry.endsWith(".jsonl")).sort()) {
      const path = join(sessionsDir, name);
      const stat = statSync(path);
      const size = stat.size;
      const mtimeMs = Math.trunc(stat.mtimeMs);
      const previous = this.database
        .query("SELECT size, mtime_ms FROM legacy_imports WHERE path = ?")
        .get(path) as LegacyImportRow | null;
      if (previous?.size === size && previous.mtime_ms === mtimeMs) continue;

      let parsed: ReturnType<typeof parseLegacySession>;
      try {
        parsed = parseLegacySession(path);
      } catch (error) {
        this.recordLegacyImport(path, size, mtimeMs, errorMessage(error));
        result.failedPaths.push(path);
        continue;
      }

      this.database.transaction(() => {
        this.writeSession(parsed.state, mtimeMs);
        this.recordLegacyImport(path, size, mtimeMs, null);
      })();
      if (parsed.truncated) result.truncatedSessionIds.push(parsed.state.id);
    }
    return result;
  }

  private migrate(): void {
    const current = (
      this.database.query("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (current > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `SQLite schema version ${current} is newer than this seri binary supports (${CURRENT_SCHEMA_VERSION})`,
      );
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.database.transaction(() => {
        this.database.exec(migration.sql);
        this.database.exec(`PRAGMA user_version = ${migration.version}`);
      })();
    }
  }

  private writeSession(state: SessionState, importedAtMs?: number): void {
    const existing = this.database.query("SELECT * FROM sessions WHERE id = ?").get(state.id) as
      | SessionRow
      | null;
    const messages = this.database
      .query("SELECT id, seq, json FROM messages WHERE session_id = ? ORDER BY seq")
      .all(state.id) as MessageRow[];
    const encoded = state.messages.map((message) => JSON.stringify(message));
    let commonPrefix = 0;
    while (
      commonPrefix < messages.length &&
      commonPrefix < encoded.length &&
      messages[commonPrefix]!.json === encoded[commonPrefix]
    ) {
      commonPrefix++;
    }
    const headerChanged =
      existing === null ||
      existing.cwd !== state.cwd ||
      existing.system_prompt !== state.systemPrompt ||
      existing.permission_mode !== state.permissionMode ||
      existing.model !== (state.model ?? null) ||
      existing.provider !== (state.provider ?? null) ||
      existing.reasoning_effort !== (state.reasoningEffort ?? null);
    const messagesChanged = commonPrefix !== messages.length || commonPrefix !== encoded.length;
    if (!headerChanged && !messagesChanged) return;

    const updatedAt = Math.max(
      importedAtMs ?? Date.now(),
      existing === null ? 0 : existing.updated_at_ms + 1,
    );
    this.database
      .query(
        `INSERT INTO sessions (
           id, cwd, system_prompt, permission_mode, model, provider, reasoning_effort, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd,
           system_prompt = excluded.system_prompt,
           permission_mode = excluded.permission_mode,
           model = excluded.model,
           provider = excluded.provider,
           reasoning_effort = excluded.reasoning_effort,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        state.id,
        state.cwd,
        state.systemPrompt,
        state.permissionMode,
        state.model ?? null,
        state.provider ?? null,
        state.reasoningEffort ?? null,
        updatedAt,
      );
    if (!messagesChanged) return;

    this.database
      .query("DELETE FROM messages WHERE session_id = ? AND seq >= ?")
      .run(state.id, commonPrefix);
    const insert = this.database.query(
      "INSERT INTO messages(session_id, seq, json, search_text) VALUES (?, ?, ?, ?)",
    );
    for (let index = commonPrefix; index < encoded.length; index++) {
      insert.run(state.id, index, encoded[index]!, textFromMessage(state.messages[index]));
    }
  }

  private recordLegacyImport(
    path: string,
    size: number,
    mtimeMs: number,
    error: string | null,
  ): void {
    this.database
      .query(
        `INSERT INTO legacy_imports(path, size, mtime_ms, imported_at, error)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           imported_at = excluded.imported_at,
           error = excluded.error`,
      )
      .run(path, size, mtimeMs, new Date().toISOString(), error);
  }
}
