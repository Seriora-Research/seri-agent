import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./paths";

function configPath(configDir: string): string {
  return join(configDir, "config.json");
}

export function loadConfig(configDir: string = getConfigDir()): Record<string, string> {
  const path = configPath(configDir);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

// config.json holds provider API keys, so it gets the same owner-only treatment as
// auth.json (see auth/authStore.ts).
function writeConfig(config: Record<string, string>, configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is a no-op when configDir already exists (POSIX mkdir ignores mode for
  // a pre-existing directory), which is the common case here — chmod explicitly.
  if (process.platform !== "win32") chmodSync(configDir, 0o700);
  writeFileSync(configPath(configDir), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function setConfigValue(key: string, value: string, configDir: string = getConfigDir()): void {
  const config = loadConfig(configDir);
  config[key] = value;
  writeConfig(config, configDir);
}

// Returns false when the key wasn't set, so callers can tell "removed" from "nothing to remove".
export function unsetConfigValue(key: string, configDir: string = getConfigDir()): boolean {
  const config = loadConfig(configDir);
  if (!(key in config)) return false;
  delete config[key];
  writeConfig(config, configDir);
  return true;
}

export function getApiKey(name: string): string | undefined {
  return process.env[name] ?? loadConfig()[name];
}
