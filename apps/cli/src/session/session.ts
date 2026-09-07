import { resolve } from "node:path";
import type { ModelProvider } from "@seri/model-catalog";
import { foldsCase } from "../caseFold";
import type { PermissionMode } from "../gate/gate";
import {
  configDirForStore,
  SessionDatabase,
  type SessionSearchOptions,
  type SessionSearchResult,
} from "./database";

export type SessionState<TMessage = unknown> = {
  id: string;
  cwd: string;
  systemPrompt: string;
  permissionMode: PermissionMode;
  model?: string;
  provider?: ModelProvider;
  reasoningEffort?: string;
  messages: TMessage[];
};

function withDatabase<T>(
  sessionsDir: string,
  fn: (database: SessionDatabase) => T,
  held?: SessionDatabase,
): T {
  if (held !== undefined) return fn(held);
  const database = new SessionDatabase(configDirForStore(sessionsDir, "sessions"));
  try {
    return fn(database);
  } finally {
    database.close();
  }
}

export function saveSession(
  state: SessionState,
  sessionsDir: string,
  database?: SessionDatabase,
): void {
  withDatabase(
    sessionsDir,
    (db) => {


      if (database === undefined) db.importLegacySessions(sessionsDir);
      db.saveSession(state);
    },
    database,
  );
}

export function loadSession<TMessage = unknown>(
  id: string,
  sessionsDir: string,
  onTruncated: () => void = () => {},
  database?: SessionDatabase,
): SessionState<TMessage> {
  return withDatabase(
    sessionsDir,
    (db) => {
      const imported = db.importLegacySessions(sessionsDir);
      if (imported.truncatedSessionIds.includes(id)) onTruncated();
      const state = db.loadSession<TMessage>(id);
      if (state === undefined) throw new Error(`Session "${id}" not found in ${sessionsDir}`);
      return state;
    },
    database,
  );
}

export function findMostRecentSession(
  sessionsDir: string,
  database?: SessionDatabase,
): string | undefined {
  return withDatabase(
    sessionsDir,
    (db) => {
      db.importLegacySessions(sessionsDir);
      return db.listSessionsByRecent()[0]?.id;
    },
    database,
  );
}

function normalizedCwd(cwd: string): string {
  const resolved = resolve(cwd);
  return foldsCase() ? resolved.toLowerCase() : resolved;
}

export function findMostRecentSessionForCwd(
  sessionsDir: string,
  cwd: string,
  database?: SessionDatabase,
): string | undefined {
  return withDatabase(
    sessionsDir,
    (db) => {
      db.importLegacySessions(sessionsDir);
      const target = normalizedCwd(cwd);
      return db.listSessionsByRecent().find((session) => normalizedCwd(session.cwd) === target)?.id;
    },
    database,
  );
}

export function searchSessions(
  query: string,
  sessionsDir: string,
  options: SessionSearchOptions = {},
  database?: SessionDatabase,
): SessionSearchResult[] {
  return withDatabase(
    sessionsDir,
    (db) => {
      db.importLegacySessions(sessionsDir);
      return db.searchSessions(query, options);
    },
    database,
  );
}

export function listSessionIds(sessionsDir: string, database?: SessionDatabase): string[] {
  return withDatabase(
    sessionsDir,
    (db) => {
      db.importLegacySessions(sessionsDir);
      return db.listSessionsByRecent().map((session) => session.id);
    },
    database,
  );
}
