import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_AUTH_FILENAME = "auth.json";

export type CodexAuth = {
  authMode: string;
  accessToken: string;
  refreshToken?: string;
  accountId: string;
  lastRefresh?: string;
};

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
}

export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), CODEX_AUTH_FILENAME);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Read-only. `codex` owns this file and rotates it. A torn or malformed file is "not connected",
// the same total degrade loadAuthSession uses.
export function loadCodexAuth(env: NodeJS.ProcessEnv = process.env): CodexAuth | undefined {
  const path = codexAuthPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
    if (parsed === undefined) return undefined;
    const tokens = asRecord(parsed.tokens);
    const accessToken = readString(tokens?.access_token);
    if (accessToken === undefined) return undefined;
    const authMode = readString(parsed.auth_mode) ?? "";
    return {
      authMode,
      accessToken,
      refreshToken: readString(tokens?.refresh_token),
      accountId: readString(tokens?.account_id) ?? "",
      lastRefresh: readString(parsed.last_refresh),
    };
  } catch {
    return undefined;
  }
}

export function hasCodexSubscription(env: NodeJS.ProcessEnv = process.env): boolean {
  const auth = loadCodexAuth(env);
  return auth !== undefined && auth.authMode === "chatgpt";
}

// auth_mode without requiring an access token. An API-key Codex login has no tokens.access_token,
// so loadCodexAuth is undefined, but /setup still needs to say "run `codex login`" rather than
// treating that file as "no login at all".
export function readCodexAuthMode(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = codexAuthPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
    return readString(parsed?.auth_mode);
  } catch {
    return undefined;
  }
}

export function jwtExpiryMs(token: string): number {
  const payload = token.split(".")[1];
  if (payload === undefined) return 0;
  try {
    const json: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const exp = asRecord(json)?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function credentialFromCodexAuth(auth: CodexAuth): {
  accessToken: string;
  accountId: string;
  expiresAt: number;
} {
  return {
    accessToken: auth.accessToken,
    accountId: auth.accountId,
    expiresAt: jwtExpiryMs(auth.accessToken),
  };
}
