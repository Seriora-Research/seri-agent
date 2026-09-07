import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { expiresAtFrom } from "./authStore";

export type XaiSubscription = {
  accessToken: string;


  refreshToken: string;
  obtainedAt: string;


  expiresAt?: string;


  scope?: string;


  accountId?: string;
};






export const XAI_AUTH_FILENAME = "xai-auth.json";

function xaiAuthPath(configDir: string): string {
  return join(configDir, XAI_AUTH_FILENAME);
}





export function saveXaiSubscription(subscription: XaiSubscription, configDir: string): void {
  atomicWriteFile(xaiAuthPath(configDir), JSON.stringify(subscription));
}




export function loadXaiSubscription(configDir: string): XaiSubscription | undefined {
  const path = xaiAuthPath(configDir);
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

export function hasXaiSubscription(configDir: string): boolean {
  return loadXaiSubscription(configDir) !== undefined;
}



export function clearXaiSubscription(configDir: string): void {
  const path = xaiAuthPath(configDir);
  if (existsSync(path)) unlinkSync(path);
}

export function subscriptionFromTokens(
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
    scope?: string;
    accountId?: string;
  },
  now: () => number = Date.now,
): XaiSubscription {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    obtainedAt: new Date(now()).toISOString(),
    expiresAt: expiresAtFrom(tokens.expiresIn),
    scope: tokens.scope,
    accountId: tokens.accountId,
  };
}
