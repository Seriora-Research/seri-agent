import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";





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

export function reconnectCodex(
  configDir: string,
  onMessage: (message: string) => void = console.log,
): void {
  clearCodexSubscriptionIgnore(configDir);
  onMessage("Re-enabled ChatGPT plan for this profile.");
}
