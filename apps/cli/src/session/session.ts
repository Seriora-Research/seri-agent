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

function withDatabase<T>(sessionsDir: string, fn: (database: SessionDatabase) => T): T {
  const database = new SessionDatabase(configDirForStore(sessionsDir, "sessions"));
  try {
    return fn(database);
  } finally {
    database.close();
  }
}

export function saveSession(state: SessionState, sessionsDir: string): void {
  withDatabase(sessionsDir, (database) => {
    database.importLegacySessions(sessionsDir);
    database.saveSession(state);
  });
}

export function loadSession<TMessage = unknown>(
  id: string,
  sessionsDir: string,
  onTruncated: () => void = () => {},
): SessionState<TMessage> {
  return withDatabase(sessionsDir, (database) => {
    const imported = database.importLegacySessions(sessionsDir);
    if (imported.truncatedSessionIds.includes(id)) onTruncated();
    const state = database.loadSession<TMessage>(id);
    if (state === undefined) throw new Error(`Session "${id}" not found in ${sessionsDir}`);
    return state;
  });
}

export function findMostRecentSession(sessionsDir: string): string | undefined {
  return withDatabase(sessionsDir, (database) => {
    database.importLegacySessions(sessionsDir);
    return database.listSessionsByRecent()[0]?.id;
  });
}

function normalizedCwd(cwd: string): string {
  const resolved = resolve(cwd);
  return foldsCase() ? resolved.toLowerCase() : resolved;
}

export function findMostRecentSessionForCwd(sessionsDir: string, cwd: string): string | undefined {
  return withDatabase(sessionsDir, (database) => {
    database.importLegacySessions(sessionsDir);
    const target = normalizedCwd(cwd);
    return database.listSessionsByRecent().find((session) => normalizedCwd(session.cwd) === target)
      ?.id;
  });
}

export function searchSessions(
  query: string,
  sessionsDir: string,
  options: SessionSearchOptions = {},
): SessionSearchResult[] {
  return withDatabase(sessionsDir, (database) => {
    database.importLegacySessions(sessionsDir);
    return database.searchSessions(query, options);
  });
}

export function listSessionIds(sessionsDir: string): string[] {
  return withDatabase(sessionsDir, (database) => {
    database.importLegacySessions(sessionsDir);
    return database.listSessionsByRecent().map((session) => session.id);
  });
}
