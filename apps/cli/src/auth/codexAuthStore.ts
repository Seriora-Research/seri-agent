import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { expiresAtFrom } from "./authStore";
import { isCodexSubscriptionIgnored } from "./codexIgnore";

export const CODEX_AUTH_FILENAME = "auth.json";

// A separate file from ~/.codex/auth.json and from WorkOS auth.json. `codex` owns the former and
// rotates it; `clearAuthSession` unlinks the latter wholesale. Two credentials with independent
// lifecycles get independent files, same as xai-auth.json.
export const CODEX_SERI_AUTH_FILENAME = "codex-auth.json";

export type CodexAuth = {
  authMode: string;
  accessToken: string;
  refreshToken?: string;
  accountId: string;
  lastRefresh?: string;
};

export type CodexSubscription = {
  accessToken: string;
  // ROTATES when the token endpoint returns a new one. Persist the response's token, never the
  // one the call started with — the same rule xaiAuthStore states for xAI.
  refreshToken: string;
  obtainedAt: string;
  expiresAt?: string;
  accountId?: string;
};

export type CodexGrant = {
  accessToken: string;
  refreshToken?: string;
  accountId: string;
  expiresAt: number;
  source: "seri" | "codex-cli";
};

function seriAuthPath(configDir: string): string {
  return join(configDir, CODEX_SERI_AUTH_FILENAME);
}

export function saveCodexSubscription(subscription: CodexSubscription, configDir: string): void {
  atomicWriteFile(seriAuthPath(configDir), JSON.stringify(subscription));
}

export function loadCodexSubscription(configDir: string): CodexSubscription | undefined {
  const path = seriAuthPath(configDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.accessToken !== "string" || typeof parsed?.refreshToken !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function hasSeriCodexSubscription(configDir: string): boolean {
  return loadCodexSubscription(configDir) !== undefined;
}

export function clearCodexSubscription(configDir: string): void {
  const path = seriAuthPath(configDir);
  if (existsSync(path)) unlinkSync(path);
}

export function subscriptionFromCodexTokens(
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
    accountId?: string;
  },
  now: () => number = Date.now,
): CodexSubscription {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    obtainedAt: new Date(now()).toISOString(),
    expiresAt: expiresAtFrom(tokens.expiresIn),
    accountId: tokens.accountId,
  };
}

export function grantFromSubscription(subscription: CodexSubscription): CodexGrant {
  const expiresAt =
    subscription.expiresAt !== undefined ? Date.parse(subscription.expiresAt) : Number.NaN;
  return {
    accessToken: subscription.accessToken,
    refreshToken: subscription.refreshToken,
    accountId: subscription.accountId ?? "",
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : jwtExpiryMs(subscription.accessToken),
    source: "seri",
  };
}

export function grantFromLeftover(auth: CodexAuth): CodexGrant {
  return {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    accountId: auth.accountId,
    expiresAt: jwtExpiryMs(auth.accessToken),
    source: "codex-cli",
  };
}

export function loadUsableCodexGrant(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): CodexGrant | undefined {
  const seri = loadCodexSubscription(configDir);
  if (seri !== undefined) return grantFromSubscription(seri);
  if (isCodexSubscriptionIgnored(configDir)) return undefined;
  const leftover = loadCodexAuth(env);
  if (leftover === undefined || leftover.authMode !== "chatgpt") return undefined;
  return grantFromLeftover(leftover);
}

export function codexHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  if (platform === "win32") return join(env.USERPROFILE || homedir(), ".codex");
  return join(env.HOME || homedir(), ".codex");
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
// the same total degrade loadAuthSession uses. seri never writes this path.
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

export function hasLeftoverCodexSubscription(env: NodeJS.ProcessEnv = process.env): boolean {
  const auth = loadCodexAuth(env);
  return auth !== undefined && auth.authMode === "chatgpt";
}

export function hasCodexSubscription(
  configDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (configDir !== undefined && loadCodexSubscription(configDir) !== undefined) return true;
  return hasLeftoverCodexSubscription(env);
}

// auth_mode without requiring an access token. An API-key Codex login has no tokens.access_token,
// so loadCodexAuth is undefined, but leftover-file inspection still needs the mode.
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

