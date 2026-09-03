import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureOwnerOnlyDir } from "../atomicWriteFile";

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  obtainedAt: string;
  // Optional, deliberately: every existing auth.json on disk lacks it, and loadAuthSession is a
  // bare JSON.parse with no migration step. A missing expiresAt must never be treated as
  // "expired" — auth/refresh.ts's 401-retry path is the authority on expiry; this is only a
  // pre-emptive hint.
  expiresAt?: string;
};

// WorkOS's real token/refresh responses carry no expires_in field (confirmed live) — a missing,
// negative, or non-finite value returns undefined rather than computing `new Date(NaN)`, whose
// toISOString() throws. A finite but out-of-Date-range value (Date's range is ~±273,790 years
// from the epoch) produces the same NaN internally, so the computed Date's own validity is
// checked too, not just expiresIn's. Shared by auth/commands.ts's login and auth/refresh.ts's
// refreshSession, the two places that populate AuthSession.expiresAt.
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

// A corrupted or unreadable auth.json is the same as no file: not authenticated.
// `login` rewrites the file wholesale on every success.
export function loadAuthSession(configDir: string): AuthSession | undefined {
  const path = authPath(configDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// Any object that parsed is not enough. Gateway coverage needs a WorkOS access token.
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
