import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelProvider } from "@seri/model-catalog";
import type { PermissionMode } from "../gate/gate";

export type SessionState<TMessage = unknown> = {
  id: string;
  cwd: string;
  systemPrompt: string;
  permissionMode: PermissionMode;
  // Optional so every session written before the model was recorded still loads. Beside
  // permissionMode because it is the same kind of thing: a per-session setting, resolved once at
  // creation and then owned by the session rather than re-read from the environment on every
  // resume — which is what lets a future /model change stick.
  model?: string;
  // Same optionality reasoning as `model`, just above: a session written before this field existed
  // still loads. Absence means "no provider was ever explicitly requested" — whether because the
  // session predates this field or because nothing was ever picked — not a synthetic "groq" that
  // was never actually chosen. DEFAULT_PROVIDER is applied only at the point of actually routing,
  // never recorded here as if it were a real request.
  provider?: ModelProvider;
  messages: TMessage[];
};

export function saveSession(state: SessionState, sessionsDir: string): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${state.id}.json`), JSON.stringify(state));
}

export function loadSession<TMessage = unknown>(
  id: string,
  sessionsDir: string,
): SessionState<TMessage> {
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
