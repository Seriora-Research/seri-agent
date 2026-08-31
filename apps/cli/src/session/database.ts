import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ModelProvider } from "@seri/model-catalog";
import { ensureOwnerOnlyDir } from "../atomicWriteFile";
import { DATABASE_FILENAME } from "../config/paths";
import type { PermissionMode } from "../gate/gate";
import type { TrajectoryHeader, TrajectoryRecord } from "../trajectory/schema";
import type { SessionState } from "./session";

export { DATABASE_FILENAME };

const CURRENT_SCHEMA_VERSION = 3;
const BUSY_TIMEOUT_MS = 5_000;

// Production layout is `<configDir>/sessions` and `<configDir>/trajectories`. Tests inject a
// throwaway directory as the store itself; using dirname of that would chmod the system temp
// root. Only peel off the layout leaf when it is actually present.
export function configDirForStore(dir: string, layoutLeaf: "sessions" | "trajectories"): string {
  const resolved = resolve(dir);
  return basename(resolved) === layoutLeaf ? dirname(resolved) : resolved;
}

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

      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO session_fts(rowid, search_text) VALUES (new.id, new.search_text);
      END;

      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO session_fts(session_fts, rowid, search_text)
        VALUES ('delete', old.id, old.search_text);
      END;

      CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO session_fts(session_fts, rowid, search_text)
        VALUES ('delete', old.id, old.search_text);
        INSERT INTO session_fts(rowid, search_text)
        VALUES (new.id, new.search_text);
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
  {
    version: 2,
    sql: `
      CREATE TABLE trajectory_records (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY(session_id, seq)
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE daemon_events (
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY(turn_id, seq)
      );

      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        cwd TEXT NOT NULL,
        timing_json TEXT NOT NULL,
        next_run_at_ms INTEGER,
        enabled INTEGER NOT NULL,
        running INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        status TEXT NOT NULL,
        response TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
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

type ScheduleRow = {
  id: string;
  task: string;
  cwd: string;
  timing_json: string;
  next_run_at_ms: number | null;
  enabled: number;
  running: number;
  created_at: string;
};

type ScheduleRunRow = {
  id: string;
  schedule_id: string;
  session_id: string;
  status: string;
  response: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export type ScheduleRecord = {
  id: string;
  task: string;
  cwd: string;
  timing: { kind: "once"; at: string } | { kind: "interval"; everySeconds: number };
  nextRunAtMs: number | null;
  enabled: boolean;
  running: boolean;
  createdAt: string;
};

export type ScheduleRunRecord = {
  id: string;
  scheduleId: string;
  sessionId: string;
  status: string;
  response: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

function scheduleFromRow(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    task: row.task,
    cwd: row.cwd,
    timing: JSON.parse(row.timing_json) as ScheduleRecord["timing"],
    nextRunAtMs: row.next_run_at_ms,
    enabled: row.enabled === 1,
    running: row.running === 1,
    createdAt: row.created_at,
  };
}

export function advanceInterval(nextRunAtMs: number, everyMs: number, nowMs: number): number {
  if (nextRunAtMs > nowMs) return nextRunAtMs;
  return nextRunAtMs + (Math.floor((nowMs - nextRunAtMs) / everyMs) + 1) * everyMs;
}

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

function parseLegacyTrajectory(path: string): {
  sessionId: string;
  rows: { seq: number; json: string }[];
} {
  const raw = readFileSync(path, "utf8");
  const parts = raw.split("\n");
  const endedWithNewline = parts.at(-1) === "";
  if (endedWithNewline) parts.pop();
  if (parts.length === 0) throw new Error("trajectory file is empty");

  const rows: { seq: number; json: string }[] = [];
  let sessionId: string | undefined;
  for (let index = 0; index < parts.length; index++) {
    const json = parts[index]!;
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch (error) {
      if (index === parts.length - 1 && !endedWithNewline) break;
      throw error;
    }
    if (typeof value !== "object" || value === null)
      throw new Error("trajectory record is invalid");
    const record = value as Record<string, unknown>;
    if (index === 0) {
      if (record.kind !== "header" || typeof record.sessionId !== "string") {
        throw new Error("trajectory header is invalid");
      }
      sessionId = record.sessionId;
      rows.push({ seq: 0, json });
      continue;
    }
    if (
      record.sessionId !== sessionId ||
      typeof record.seq !== "number" ||
      !Number.isInteger(record.seq) ||
      record.seq < 1
    ) {
      throw new Error("trajectory record sequence is invalid");
    }
    rows.push({ seq: record.seq, json });
  }
  if (sessionId === undefined) throw new Error("trajectory header is missing");
  return { sessionId, rows };
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
      // LIMIT 1, not 0: SQLite can skip MATCH when the limit is zero, so a missing FTS5 build
      // would not throw. A hyphenated token is FTS column syntax (`fts-probe` means column
      // `probe`), so the probe string has to be a bare term.
      this.database
        .query("SELECT rowid FROM session_fts WHERE session_fts MATCH ? LIMIT 1")
        .all("probe");
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

  getPragmas(): {
    foreignKeys: number;
    journalMode: string;
    busyTimeout: number;
    userVersion: number;
  } {
    return {
      foreignKeys: (this.database.query("PRAGMA foreign_keys").get() as { foreign_keys: number })
        .foreign_keys,
      journalMode: (this.database.query("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode,
      busyTimeout: (this.database.query("PRAGMA busy_timeout").get() as { timeout: number })
        .timeout,
      userVersion: (this.database.query("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    };
  }

  saveSession(state: SessionState): void {
    this.database.transaction(() => this.writeSession(state))();
  }

  loadSession<TMessage = unknown>(id: string): SessionState<TMessage> | undefined {
    const header = this.database
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | null;
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
    for (const name of readdirSync(sessionsDir)
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort()) {
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

  importLegacyTrajectories(trajectoriesDir: string): { failedPaths: string[] } {
    const result = { failedPaths: [] as string[] };
    if (!existsSync(trajectoriesDir)) return result;
    for (const name of readdirSync(trajectoriesDir)
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort()) {
      const path = join(trajectoriesDir, name);
      const stat = statSync(path);
      const size = stat.size;
      const mtimeMs = Math.trunc(stat.mtimeMs);
      const previous = this.database
        .query("SELECT size, mtime_ms FROM legacy_imports WHERE path = ?")
        .get(path) as LegacyImportRow | null;
      if (previous?.size === size && previous.mtime_ms === mtimeMs) continue;

      let parsed: ReturnType<typeof parseLegacyTrajectory>;
      try {
        parsed = parseLegacyTrajectory(path);
      } catch (error) {
        this.recordLegacyImport(path, size, mtimeMs, errorMessage(error));
        result.failedPaths.push(path);
        continue;
      }

      this.database.transaction(() => {
        this.database
          .query("DELETE FROM trajectory_records WHERE session_id = ?")
          .run(parsed.sessionId);
        const insert = this.database.query(
          "INSERT INTO trajectory_records(session_id, seq, json) VALUES (?, ?, ?)",
        );
        for (const row of parsed.rows) insert.run(parsed.sessionId, row.seq, row.json);
        this.recordLegacyImport(path, size, mtimeMs, null);
      })();
    }
    return result;
  }

  appendTrajectory(
    header: TrajectoryHeader,
    record: Omit<TrajectoryRecord, "seq">,
  ): TrajectoryRecord {
    return this.database.transaction(() => {
      this.database
        .query("INSERT OR IGNORE INTO trajectory_records(session_id, seq, json) VALUES (?, 0, ?)")
        .run(header.sessionId, JSON.stringify(header));
      const nextSeq =
        (
          this.database
            .query("SELECT MAX(seq) AS seq FROM trajectory_records WHERE session_id = ?")
            .get(header.sessionId) as { seq: number }
        ).seq + 1;
      const sequenced = { ...record, seq: nextSeq } as TrajectoryRecord;
      this.database
        .query("INSERT INTO trajectory_records(session_id, seq, json) VALUES (?, ?, ?)")
        .run(header.sessionId, nextSeq, JSON.stringify(sequenced));
      return sequenced;
    })();
  }

  readTrajectory(sessionId: string): unknown[] {
    return (
      this.database
        .query("SELECT json FROM trajectory_records WHERE session_id = ? ORDER BY seq")
        .all(sessionId) as { json: string }[]
    ).map((row) => JSON.parse(row.json));
  }

  pruneTrajectories(opts: { cutoff: string; keepSessionId?: string }): string[] {
    const stale = (
      this.database
        .query(
          `SELECT session_id AS sessionId
             FROM trajectory_records
            WHERE session_id IS NOT ?
            GROUP BY session_id
           HAVING MAX(COALESCE(json_extract(json, '$.ts'), json_extract(json, '$.startedAt'))) < ?
            ORDER BY session_id`,
        )
        .all(opts.keepSessionId ?? null, opts.cutoff) as { sessionId: string }[]
    ).map((row) => row.sessionId);
    if (stale.length === 0) return stale;
    this.database.transaction(() => {
      const remove = this.database.query("DELETE FROM trajectory_records WHERE session_id = ?");
      for (const sessionId of stale) remove.run(sessionId);
    })();
    return stale;
  }

  insertTurn(id: string, sessionId: string, startedAt: string): void {
    this.database
      .query(
        "INSERT INTO turns(id, session_id, status, started_at, finished_at) VALUES (?, ?, 'running', ?, NULL)",
      )
      .run(id, sessionId, startedAt);
  }

  hasTurn(id: string): boolean {
    return (
      (this.database.query("SELECT id FROM turns WHERE id = ?").get(id) as {
        id: string;
      } | null) !== null
    );
  }

  finishTurn(id: string, finishedAt: string): void {
    this.database
      .query("UPDATE turns SET status = 'complete', finished_at = ? WHERE id = ?")
      .run(finishedAt, id);
  }

  appendDaemonEvent(turnId: string, seq: number, event: unknown): void {
    this.database
      .query("INSERT INTO daemon_events(turn_id, seq, json) VALUES (?, ?, ?)")
      .run(turnId, seq, JSON.stringify(event));
  }

  listDaemonEventsAfter(turnId: string, afterSeq: number): unknown[] {
    return (
      this.database
        .query("SELECT json FROM daemon_events WHERE turn_id = ? AND seq > ? ORDER BY seq")
        .all(turnId, afterSeq) as { json: string }[]
    ).map((row) => JSON.parse(row.json));
  }

  getArchivistCursor(sessionId: string): number {
    const row = this.database
      .query("SELECT archivist_cursor FROM sessions WHERE id = ?")
      .get(sessionId) as { archivist_cursor: number } | null;
    return row?.archivist_cursor ?? 0;
  }

  setArchivistCursor(sessionId: string, cursor: number): void {
    this.database
      .query("UPDATE sessions SET archivist_cursor = ? WHERE id = ?")
      .run(cursor, sessionId);
  }

  insertSchedule(row: {
    id: string;
    task: string;
    cwd: string;
    timingJson: string;
    nextRunAtMs: number | null;
    enabled: number;
    createdAt: string;
  }): void {
    this.database
      .query(
        `INSERT INTO schedules(id, task, cwd, timing_json, next_run_at_ms, enabled, running, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(row.id, row.task, row.cwd, row.timingJson, row.nextRunAtMs, row.enabled, row.createdAt);
  }

  listSchedules(): ScheduleRecord[] {
    return (
      this.database.query("SELECT * FROM schedules ORDER BY created_at").all() as ScheduleRow[]
    ).map(scheduleFromRow);
  }

  getSchedule(id: string): ScheduleRecord | undefined {
    const row = this.database
      .query("SELECT * FROM schedules WHERE id = ?")
      .get(id) as ScheduleRow | null;
    return row === null ? undefined : scheduleFromRow(row);
  }

  disableSchedule(id: string): boolean {
    const existing = this.getSchedule(id);
    if (existing === undefined) return false;
    this.database
      .query("UPDATE schedules SET enabled = 0, next_run_at_ms = NULL WHERE id = ?")
      .run(id);
    return true;
  }

  listDueSchedules(nowMs: number): ScheduleRecord[] {
    return (
      this.database
        .query(
          `SELECT * FROM schedules
            WHERE enabled = 1 AND running = 0 AND next_run_at_ms IS NOT NULL AND next_run_at_ms <= ?
            ORDER BY next_run_at_ms, id`,
        )
        .all(nowMs) as ScheduleRow[]
    ).map(scheduleFromRow);
  }

  skipMissedSchedules(nowMs: number): void {
    this.database.transaction(() => {
      this.database.query("UPDATE schedules SET running = 0").run();
      for (const schedule of this.listEnabledSchedules()) {
        if (schedule.nextRunAtMs === null || schedule.nextRunAtMs > nowMs) continue;
        if (schedule.timing.kind === "once") {
          this.database
            .query("UPDATE schedules SET enabled = 0, next_run_at_ms = NULL WHERE id = ?")
            .run(schedule.id);
          continue;
        }
        this.database
          .query("UPDATE schedules SET next_run_at_ms = ? WHERE id = ?")
          .run(
            advanceInterval(schedule.nextRunAtMs, schedule.timing.everySeconds * 1000, nowMs),
            schedule.id,
          );
      }
    })();
  }

  claimSchedule(id: string, nowMs: number): ScheduleRecord | undefined {
    return this.database.transaction(() => {
      const row = this.database
        .query(
          `SELECT * FROM schedules
            WHERE id = ? AND enabled = 1 AND running = 0
              AND next_run_at_ms IS NOT NULL AND next_run_at_ms <= ?`,
        )
        .get(id, nowMs) as ScheduleRow | null;
      if (row === null) return undefined;
      const schedule = scheduleFromRow(row);
      if (schedule.timing.kind === "once") {
        this.database
          .query(
            "UPDATE schedules SET running = 1, enabled = 0, next_run_at_ms = NULL WHERE id = ?",
          )
          .run(id);
      } else {
        this.database
          .query("UPDATE schedules SET running = 1, next_run_at_ms = ? WHERE id = ?")
          .run(
            advanceInterval(schedule.nextRunAtMs!, schedule.timing.everySeconds * 1000, nowMs),
            id,
          );
      }
      return this.getSchedule(id);
    })();
  }

  clearScheduleRunning(id: string): void {
    this.database.query("UPDATE schedules SET running = 0 WHERE id = ?").run(id);
  }

  insertScheduleRun(row: {
    id: string;
    scheduleId: string;
    sessionId: string;
    status: string;
    response: string | null;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
  }): void {
    this.database
      .query(
        `INSERT INTO schedule_runs(id, schedule_id, session_id, status, response, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.scheduleId,
        row.sessionId,
        row.status,
        row.response,
        row.error,
        row.startedAt,
        row.finishedAt,
      );
  }

  listScheduleRuns(scheduleId: string): ScheduleRunRecord[] {
    return (
      this.database
        .query("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at")
        .all(scheduleId) as ScheduleRunRow[]
    ).map((row) => ({
      id: row.id,
      scheduleId: row.schedule_id,
      sessionId: row.session_id,
      status: row.status,
      response: row.response,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
  }

  private listEnabledSchedules(): ScheduleRecord[] {
    return (
      this.database.query("SELECT * FROM schedules WHERE enabled = 1").all() as ScheduleRow[]
    ).map(scheduleFromRow);
  }

  private migrate(): void {
    const current = (this.database.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
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
    const existing = this.database
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(state.id) as SessionRow | null;
    const messages = this.database
      .query("SELECT id, seq, json FROM messages WHERE session_id = ? ORDER BY seq")
      .all(state.id) as MessageRow[];
    const encoded = state.messages.map((message) => {
      const json = JSON.stringify(message);
      if (json === undefined) throw new Error("Session messages must be JSON-serializable");
      return json;
    });
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
