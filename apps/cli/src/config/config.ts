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
  // UTF-16 LE BOM (FF FE): PowerShell 5 `Out-File` and Notepad "Unicode" write this; utf8 then JSON.parse sees NULs.
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

export function setConfigValues(
  entries: Record<string, string>,
  configDir: string = getConfigDir(),
): void {
  const config = loadConfig(configDir);
  Object.assign(config, entries);
  writeConfig(config, configDir);
}

export function unsetConfigValue(key: string, configDir: string = getConfigDir()): boolean {
  // Object.hasOwn, not `in`: `seri config unset toString` would otherwise hit Object.prototype.
  const config = loadConfig(configDir);
  if (!Object.hasOwn(config, key)) return false;
  delete config[key];
  writeConfig(config, configDir);
  return true;
}

export function configBoolean(value: string | undefined): boolean {
  return value !== "false";
}

export const BLOCK_READS_OUTSIDE_WORKING_DIRECTORIES_KEY =
  "SERI_BLOCK_READS_OUTSIDE_WORKING_DIRECTORIES";

export function standingDenyReadsOutside(value: string | undefined): boolean {
  return value === "true";
}

export function tuiBackgroundColor(value: string | undefined): string | undefined {
  return value !== undefined && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
}

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
    enabled: configBoolean(configValue("SERI_VERIFY_ENABLED", config)),
    command: configValue("SERI_VERIFY_COMMAND", config),
  };
}

export type MemoryConfig = { approvalRequired: boolean; archivistEnabled: boolean };

export function loadMemoryConfig(configDir?: string): MemoryConfig {
  const config = loadConfig(configDir);
  return {
    approvalRequired: configBoolean(configValue("SERI_MEMORY_APPROVAL", config)),
    archivistEnabled: configBoolean(configValue("SERI_ARCHIVIST_ENABLED", config)),
  };
}

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

export function getApiKey(name: string, configDir?: string): string | undefined {
  // Empty env var falls through to the config file, same as `||` for SERI_PROFILE.
  return process.env[name] || loadConfig(configDir)[name] || undefined;
}
