import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  // mkdirSync's and writeFileSync's `mode` are both no-ops when the target already exists
  // (POSIX mkdir ignores mode for an existing dir; Node applies a file's mode only on
  // O_CREAT) — and a pre-existing config.json is the common case, since users hand-created
  // it before this command existed. chmod both explicitly.
  if (process.platform !== "win32") chmodSync(configDir, 0o700);

  // Write-then-rename: a truncating in-place write that is interrupted leaves a partial
  // config.json, which makes every later command throw from JSON.parse — including
  // `seri config` itself, since it reads before writing. rename is atomic, so readers
  // see either the old file or the new one.
  const path = configPath(configDir);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
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

// configDir is threaded through rather than always resolved internally so that a caller
// which writes with an explicit dir (`seri config set`) reads back from that same dir.
export function getApiKey(name: string, configDir?: string): string | undefined {
  // Deliberately not `??`: an env var set to the empty string should fall through to the
  // config file and then to the caller's default, not win as a valid-looking value.
  return process.env[name] || loadConfig(configDir)[name] || undefined;
}
