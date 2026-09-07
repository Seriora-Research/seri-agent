import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureOwnerOnlyDir } from "../atomicWriteFile";

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  obtainedAt: string;




  expiresAt?: string;
};







export function expiresAtFrom(expiresIn: number | undefined): string | undefined {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn < 0) {
    return undefined;
  }
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  return Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : undefined;
}

export const AUTH_FILENAME = "auth.json";

function authPath(configDir: string): string {
  return join(configDir, AUTH_FILENAME);
}

export function saveAuthSession(session: AuthSession, configDir: string): void {
  ensureOwnerOnlyDir(configDir);
  writeFileSync(authPath(configDir), JSON.stringify(session), { mode: 0o600 });
}



export function loadAuthSession(configDir: string): AuthSession | undefined {
  const path = authPath(configDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}


export function hasHostedAuth(configDir: string): boolean {
  const session = loadAuthSession(configDir);
  return (
    session !== undefined &&
    typeof session.accessToken === "string" &&
    session.accessToken.length > 0
  );
}

export function clearAuthSession(configDir: string): void {
  const path = authPath(configDir);
  if (existsSync(path)) unlinkSync(path);
}
