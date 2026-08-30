import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { expiresAtFrom } from "./authStore";

export type XaiSubscription = {
  accessToken: string;
  // ROTATES on every refresh, and xAI invalidates the previous value. The response's token, never
  // the one the call started with — the same rule auth/refresh.ts states for WorkOS.
  refreshToken: string;
  obtainedAt: string;
  // Optional for the same reason AuthSession.expiresAt is: a missing value means "no hint", never
  // "expired". The 401-retry path stays the authority on whether a token still works.
  expiresAt?: string;
  // The granted scope, verbatim. The only local evidence for telling a later 403 apart from a
  // scope that was never granted at consent time.
  scope?: string;
};

// A separate file from auth.json, not a field inside it. `clearAuthSession` unlinks that file
// wholesale, so co-locating would make /logout from the seri account silently disconnect an
// unrelated xAI subscription; and `login()` rewrites auth.json from only the WorkOS fields, so a
// nested key there is one spread away from being dropped. Two credentials with independent
// lifecycles get independent files.
export const XAI_AUTH_FILENAME = "xai-auth.json";

function xaiAuthPath(configDir: string): string {
  return join(configDir, XAI_AUTH_FILENAME);
}

// atomicWriteFile, unlike saveAuthSession's plain writeFileSync. For WorkOS a torn write costs a
// re-login. Here a torn write during a refresh-token rotation loses the only token that can mint
// the next one, while the previous one is already dead server-side — an unrecoverable state that
// needs a full re-consent.
export function saveXaiSubscription(subscription: XaiSubscription, configDir: string): void {
  atomicWriteFile(xaiAuthPath(configDir), JSON.stringify(subscription));
}

// Total degrade, matching loadAuthSession: an unreadable or malformed file genuinely means "not
// connected", which is the same state as no file at all. Nothing partial is worth preserving —
// a successful connect rewrites the file wholesale.
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

// Local only. This does not revoke anything at xAI — the connect UI has to say so, or a user who
// disconnects will believe seri's access was withdrawn upstream when it was not.
export function clearXaiSubscription(configDir: string): void {
  const path = xaiAuthPath(configDir);
  if (existsSync(path)) unlinkSync(path);
}

export function subscriptionFromTokens(
  tokens: { accessToken: string; refreshToken: string; expiresIn?: number; scope?: string },
  now: () => number = Date.now,
): XaiSubscription {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    obtainedAt: new Date(now()).toISOString(),
    expiresAt: expiresAtFrom(tokens.expiresIn),
    scope: tokens.scope,
  };
}
