import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { getConfigDir } from "./paths";

export const CONFIG_FILENAME = "config.json";

function configPath(configDir: string): string {
  return join(configDir, CONFIG_FILENAME);
}

function readConfigText(path: string): string {
  const buf = readFileSync(path);
  // UTF-16 LE BOM (FF FE): PowerShell 5 `Out-File` and Notepad "Unicode" write this.
  // Read as utf8, those files are NULs, and Bun's JSON.parse reports
  // `Unrecognized token ''` because the token is the invisible `\0`.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  return buf.toString("utf8");
}

export type ConfigInspect =
  | { status: "missing" }
  | { status: "ok"; values: Record<string, string> }
  | { status: "malformed"; reason: "unreadable" | "not-object" };

export function inspectConfig(configDir: string = getConfigDir()): ConfigInspect {
  const path = configPath(configDir);
  if (!existsSync(path)) return { status: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readConfigText(path));
  } catch {
    return { status: "malformed", reason: "unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "malformed", reason: "not-object" };
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") values[key] = value;
  }
  return { status: "ok", values };
}

export function loadConfig(configDir: string = getConfigDir()): Record<string, string> {
  const inspected = inspectConfig(configDir);
  return inspected.status === "ok" ? inspected.values : {};
}

// Owner-only, write-then-rename: config.json holds API keys, and a colliding tmp name
// races two writers (atomicWriteFile.ts). /memory approval and archivist toggles write here too.
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
// Object.hasOwn, not `key in`: `config` is a plain object, so `key in config` is also true for an
// inherited Object.prototype member — `seri config unset toString` would otherwise report
// "Removed" and rewrite the file having deleted nothing.
export function unsetConfigValue(key: string, configDir: string = getConfigDir()): boolean {
  const config = loadConfig(configDir);
  if (!Object.hasOwn(config, key)) return false;
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

export const BLOCK_READS_OUTSIDE_WORKING_DIRECTORIES_KEY =
  "SERI_BLOCK_READS_OUTSIDE_WORKING_DIRECTORIES";

// Unset and every spelling other than the exact string "true" stay off.
// configBoolean is value !== "false", so unset would become a standing deny.
export function standingDenyReadsOutside(value: string | undefined): boolean {
  return value === "true";
}

// The ground the TUI paints, or nothing. `#rrggbb` only — `#rgb`, `rgb()` and named colors each
// cost a validator no caller needs. Everything else, the documented `terminal` spelling included,
// resolves to undefined and leaves the terminal's own background alone: this runs while the
// renderer is being built (tui/runtime/renderOptions.ts), where a throw would take the whole TUI
// down and a warning would have nowhere to print, so a mistyped color reads as no preference at
// all rather than as an error.
export function tuiBackgroundColor(value: string | undefined): string | undefined {
  return value !== undefined && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
}

// env-then-file precedence, falsy-skip: an env var set to "" is treated the same as unset, so it
// falls through to config.json rather than winning as a valid-looking empty value. Mirrors
// provider/keys.ts's stateFromConfig — value and source come from ONE truthiness test, so a
// caller that needs both (decideConfigOpen, tui/commands.ts) can't have them disagree the way an
// independently-computed source (`!== undefined`) and value (`||`) once did.
export function resolveConfigValue(
  name: string,
  config: Record<string, string>,
): { value: string | undefined; source: "env" | "config" | "unset" } {
  if (process.env[name]) return { value: process.env[name], source: "env" };
  if (config[name]) return { value: config[name], source: "config" };
  return { value: undefined, source: "unset" };
}

export function configValue(name: string, config: Record<string, string>): string | undefined {
  return resolveConfigValue(name, config).value;
}

export type VerifyConfig = { enabled: boolean; command: string | undefined };

export function loadVerifyConfig(configDir?: string): VerifyConfig {
  const config = loadConfig(configDir);
  return {
    // Separate from `command` being unset, because this is the named mitigation for the per-write
    // cost — a user who configured a command needs a way to suspend it without losing it.
    enabled: configBoolean(configValue("SERI_VERIFY_ENABLED", config)),
    command: configValue("SERI_VERIFY_COMMAND", config),
  };
}

// The two /memory-controlled toggles, sharing configBoolean's `!== "false"` shape
// (above) so a typo can't silently disable either safe default. Both are read live rather than
// cached, since either can flip mid-session via /memory approval on|off or /memory archivist
// on|off and driveLoop re-reads this every turn.
export type MemoryConfig = { approvalRequired: boolean; archivistEnabled: boolean };

export function loadMemoryConfig(configDir?: string): MemoryConfig {
  const config = loadConfig(configDir);
  return {
    approvalRequired: configBoolean(configValue("SERI_MEMORY_APPROVAL", config)),
    archivistEnabled: configBoolean(configValue("SERI_ARCHIVIST_ENABLED", config)),
  };
}

// Takes an already-loaded config object, unlike loadVerifyConfig/loadMemoryConfig above: the
// /effort precedence chain (session override -> this config default -> nothing sent) needs the
// same `config` a caller already has in hand rather than re-reading config.json a second time.
// Read fresh on every call, never cached, since SERI_REASONING_EFFORT can change mid-session via
// `seri config set`.
export function loadReasoningEffortConfig(config: Record<string, string>): string | undefined {
  return configValue("SERI_REASONING_EFFORT", config);
}

export const DEFAULT_TRAJECTORY_RETENTION_DAYS = 30;

export type TrajectoryConfig = { enabled: boolean; retentionDays: number };

function parseRetentionDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TRAJECTORY_RETENTION_DAYS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_TRAJECTORY_RETENTION_DAYS;
  return parsed;
}

export function loadTrajectoryConfig(configDir?: string): TrajectoryConfig {
  const config = loadConfig(configDir);
  return {
    enabled: configBoolean(configValue("SERI_TRAJECTORY_ENABLED", config)),
    retentionDays: parseRetentionDays(configValue("SERI_TRAJECTORY_RETENTION_DAYS", config)),
  };
}

// Mirrors provider/defaults.ts's persistDefaultModel: called only from runTui's own per-turn
// confirm-then-persist tracking (cli.ts), after a turn using this tier has actually succeeded —
// never from /effort's own handler directly.
export function persistDefaultReasoningEffort(tier: string, configDir?: string): void {
  setConfigValue("SERI_REASONING_EFFORT", tier, configDir);
}

export const ALLOW_UNSANDBOXED_COMMANDS_KEY = "SERI_ALLOW_UNSANDBOXED_COMMANDS";

export type SandboxConfig = { allowUnsandboxedCommands: boolean };

export function loadSandboxConfig(configDir?: string): SandboxConfig {
  const config = loadConfig(configDir);
  return {
    allowUnsandboxedCommands: configBoolean(configValue(ALLOW_UNSANDBOXED_COMMANDS_KEY, config)),
  };
}

// configDir is threaded through rather than always resolved internally so that a caller
// which writes with an explicit dir (`seri config set`) reads back from that same dir.
export function getApiKey(name: string, configDir?: string): string | undefined {
  // Deliberately not `??`: an env var set to the empty string should fall through to the
  // config file and then to the caller's default, not win as a valid-looking value.
  return process.env[name] || loadConfig(configDir)[name] || undefined;
}
