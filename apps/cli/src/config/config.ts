import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { getConfigDir } from "./paths";

export const CONFIG_FILENAME = "config.json";

function configPath(configDir: string): string {
  return join(configDir, CONFIG_FILENAME);
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
// auth.json (see auth/authStore.ts). atomicWriteFile.ts's shared helper: write-then-rename means
// a truncating in-place write that is interrupted leaves a partial config.json, which makes every
// later command throw from JSON.parse — including `seri config` itself, since it reads before
// writing; the non-colliding tmp name (that module's own comment) is what /memory approval on|off
// and /memory archivist on|off now need too, as new concurrent writers to this same file.
function writeConfig(config: Record<string, string>, configDir: string): void {
  atomicWriteFile(configPath(configDir), JSON.stringify(config, null, 2));
}

export function setConfigValue(
  key: string,
  value: string,
  configDir: string = getConfigDir(),
): void {
  const config = loadConfig(configDir);
  config[key] = value;
  writeConfig(config, configDir);
}

// A sibling of setConfigValue, not a replacement: that one keeps its exact existing
// signature/behavior (seri config set and its own tests call it directly). This one exists for a
// caller that needs several keys to land together — a single loadConfig/writeConfig pair, so
// there is exactly one write-then-rename (writeConfig's own comment) for the whole batch, not one
// per key. Two independent setConfigValue calls for a logically-paired update (code-review
// finding: apps/cli/src/provider/defaults.ts's persistDefaultModel) can be interrupted between
// them — a process kill, or the second call throwing (EACCES/ENOSPC/EISDIR) — leaving config.json
// with only one of the two keys updated.
export function setConfigValues(
  entries: Record<string, string>,
  configDir: string = getConfigDir(),
): void {
  const config = loadConfig(configDir);
  Object.assign(config, entries);
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

// The check command post-write verification runs (verify/wrapTools.ts). There is no auto-discovery
// behind this: with no `SERI_VERIFY_COMMAND` set, nothing is ever spawned. A harness must not find
// a command inside the repository it is editing and execute it — Aider ships its own linters and
// requires an explicit `--lint-cmd` for a project's own, and OpenCode runs a language server and
// never executes project scripts. Reading `scripts.typecheck` out of whatever `package.json`
// happens to be nearest and running it is what neither of them does.
//
// Flat string keys rather than a nested `verify: {...}` object: config.json is a
// Record<string, string> here, `config list` masks every value it holds, and nesting one object
// inside it would change both. The env-var-shaped names are deliberate — they get the same
// env-then-file precedence getApiKey has, for free.
// On unless explicitly turned off: a mistyped value must not silently disable a feature guarded
// by one of these flags.
export function configBoolean(value: string | undefined): boolean {
  return value !== "false";
}

export type VerifyConfig = { enabled: boolean; command: string | undefined };

export function loadVerifyConfig(configDir?: string): VerifyConfig {
  const config = loadConfig(configDir);
  const read = (name: string): string | undefined => process.env[name] || config[name] || undefined;
  return {
    // Separate from `command` being unset, because this is the named mitigation for the per-write
    // cost — a user who configured a command needs a way to suspend it without losing it.
    enabled: configBoolean(read("SERI_VERIFY_ENABLED")),
    command: read("SERI_VERIFY_COMMAND"),
  };
}

// Stage 6b: the two /memory-controlled toggles, sharing configBoolean's `!== "false"` shape
// (above) so a typo can't silently disable either safe default. Both are read live rather than
// cached, since either can flip mid-session via /memory approval on|off or /memory archivist
// on|off and driveLoop re-reads this every turn.
export type MemoryConfig = { approvalRequired: boolean; archivistEnabled: boolean };

export function loadMemoryConfig(configDir?: string): MemoryConfig {
  const config = loadConfig(configDir);
  const read = (name: string): string | undefined => process.env[name] || config[name] || undefined;
  return {
    approvalRequired: configBoolean(read("SERI_MEMORY_APPROVAL")),
    archivistEnabled: configBoolean(read("SERI_ARCHIVIST_ENABLED")),
  };
}

// configDir is threaded through rather than always resolved internally so that a caller
// which writes with an explicit dir (`seri config set`) reads back from that same dir.
export function getApiKey(name: string, configDir?: string): string | undefined {
  // Deliberately not `??`: an env var set to the empty string should fall through to the
  // config file and then to the caller's default, not win as a valid-looking value.
  return process.env[name] || loadConfig(configDir)[name] || undefined;
}
