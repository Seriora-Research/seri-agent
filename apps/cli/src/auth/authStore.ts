import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  obtainedAt: string;
};

function authPath(configDir: string): string {
  return join(configDir, "auth.json");
}

export function saveAuthSession(session: AuthSession, configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is a no-op when configDir already exists (POSIX mkdir ignores mode for
  // a pre-existing directory), which is the common case here — chmod explicitly.
  if (process.platform !== "win32") chmodSync(configDir, 0o700);
  writeFileSync(authPath(configDir), JSON.stringify(session), { mode: 0o600 });
}

export function loadAuthSession(configDir: string): AuthSession | undefined {
  const path = authPath(configDir);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function clearAuthSession(configDir: string): void {
  const path = authPath(configDir);
  if (existsSync(path)) unlinkSync(path);
}
