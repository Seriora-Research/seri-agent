import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode } from "../gate/gate";

export type SessionState<TMessage = unknown> = {
  id: string;
  cwd: string;
  systemPrompt: string;
  permissionMode: PermissionMode;
  messages: TMessage[];
};

export function saveSession(state: SessionState, sessionsDir: string): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${state.id}.json`), JSON.stringify(state));
}

export function loadSession<TMessage = unknown>(id: string, sessionsDir: string): SessionState<TMessage> {
  const path = join(sessionsDir, `${id}.json`);
  if (!existsSync(path)) throw new Error(`Session "${id}" not found in ${sessionsDir}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function findMostRecentSession(sessionsDir: string): string | undefined {
  if (!existsSync(sessionsDir)) return undefined;

  let mostRecentId: string | undefined;
  let mostRecentMtime = -Infinity;
  for (const file of readdirSync(sessionsDir)) {
    if (!file.endsWith(".json")) continue;
    const mtime = statSync(join(sessionsDir, file)).mtimeMs;
    if (mtime > mostRecentMtime) {
      mostRecentMtime = mtime;
      mostRecentId = file.slice(0, -".json".length);
    }
  }
  return mostRecentId;
}
