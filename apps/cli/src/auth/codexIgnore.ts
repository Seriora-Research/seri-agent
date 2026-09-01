import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";

// Profile-local opt-out for a ChatGPT-plan login that lives in ~/.codex/auth.json.
// Presence means this profile ignores that login. seri never writes the Codex file;
// disconnecting here only creates this flag. Independent of auth.json so /logout
// (WorkOS) cannot drop it.
export const CODEX_IGNORE_FILENAME = "codex-ignore";

function ignorePath(configDir: string): string {
  return join(configDir, CODEX_IGNORE_FILENAME);
}

export function isCodexSubscriptionIgnored(configDir: string): boolean {
  return existsSync(ignorePath(configDir));
}

export function ignoreCodexSubscription(configDir: string): void {
  atomicWriteFile(ignorePath(configDir), "\n");
}

export function clearCodexSubscriptionIgnore(configDir: string): void {
  const path = ignorePath(configDir);
  if (existsSync(path)) unlinkSync(path);
}

export function disconnectCodex(
  configDir: string,
  onMessage: (message: string) => void = console.log,
): void {
  ignoreCodexSubscription(configDir);
  onMessage(
    "Disconnected ChatGPT plan. seri will stop using it in this profile; the Codex CLI login was not revoked.",
  );
}

export function reconnectCodex(
  configDir: string,
  onMessage: (message: string) => void = console.log,
): void {
  clearCodexSubscriptionIgnore(configDir);
  onMessage("Re-enabled ChatGPT plan via Codex for this profile.");
}
