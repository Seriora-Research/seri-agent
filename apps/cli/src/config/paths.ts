import { join } from "node:path";
import { AUTH_FILENAME } from "../auth/authStore";
import { CODEX_SERI_AUTH_FILENAME } from "../auth/codexAuthStore";
import { CODEX_IGNORE_FILENAME } from "../auth/codexIgnore";
import { foldsCase } from "../caseFold";
import { PERMISSIONS_FILENAME } from "../permissions/store";
import { CONFIG_FILENAME } from "./config";
import { resolveUserHome } from "./userHome";

export { resolveUserHome } from "./userHome";

export function getBaseConfigDir(): string {
  return join(resolveUserHome(), ".seri");
}

export const DEFAULT_PROFILE = "default";

export const AGENTS_DIRNAME = "agents";
export const SKILLS_DIRNAME = "skills";
export const RULES_DIRNAME = "rules";
export const MCP_DIRNAME = "mcp";
export const HOOKS_DIRNAME = "hooks";
export const MEMORIES_DIRNAME = "memories";
export const PENDING_DIRNAME = "pending";
export const TRAJECTORIES_DIRNAME = "trajectories";
export const PLANS_DIRNAME = "plans";
export const DATABASE_FILENAME = "seri.db";
export const DAEMON_DESCRIPTOR_FILENAME = "daemon.json";
export const DAEMON_LOCK_FILENAME = "daemon.lock";

// install.ps1 writes ~\.seri\bin from $env:USERPROFILE, not $HOME, so HOME≠USERPROFILE on Windows splits the binary and config roots.
// Lazy: paths.ts reads CONFIG_FILENAME from config.ts and config.ts imports getConfigDir from here; a top-level read throws at import time.
let reservedProfileNames: ReadonlySet<string> | undefined;
export function getReservedProfileNames(): ReadonlySet<string> {
  reservedProfileNames ??= new Set([
    CONFIG_FILENAME,
    AUTH_FILENAME,
    PERMISSIONS_FILENAME,
    CODEX_IGNORE_FILENAME,
    CODEX_SERI_AUTH_FILENAME,
    "sessions",
    "checkpoints",
    "rg",
    "bin",
    AGENTS_DIRNAME,
    SKILLS_DIRNAME,
    RULES_DIRNAME,
    MCP_DIRNAME,
    HOOKS_DIRNAME,
    MEMORIES_DIRNAME,
    PENDING_DIRNAME,
    TRAJECTORIES_DIRNAME,
    PLANS_DIRNAME,
    DATABASE_FILENAME,
    DAEMON_DESCRIPTOR_FILENAME,
    DAEMON_LOCK_FILENAME,
  ]);
  return reservedProfileNames;
}

let override: string | undefined;

// `||`, not `??`, so SERI_PROFILE="" reads as unset.
function profileFromEnv(): string | undefined {
  return process.env.SERI_PROFILE || undefined;
}

export function resolveProfile(flagValue: string | undefined): {
  profile: string;
  source: "flag" | "env" | "default";
} {
  // Truthy, not `!== undefined`: `seri --profile "$UNSET_VAR"` expands to "" and must fall through.
  if (flagValue) return { profile: flagValue, source: "flag" };
  const envProfile = profileFromEnv();
  if (envProfile !== undefined) return { profile: envProfile, source: "env" };
  return { profile: DEFAULT_PROFILE, source: "default" };
}

export function currentProfile(): { profile: string; source: "flag" | "env" | "default" } {
  return resolveProfile(override);
}

function activeProfile(): string {
  return currentProfile().profile;
}

export function setProfileOverride(profile: string | undefined): void {
  override = profile;
}

export function profileNameError(name: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(name))
    return `"${name}" may only contain letters, numbers, ".", "_" and "-"`;
  if (name === "." || name === "..") return `"${name}" is not a valid profile name`;
  // NTFS/APFS fold case on win32/darwin; ext4 does not, so Linux reserved-name checks stay exact.
  if (getReservedProfileNames().has(foldsCase() ? name.toLowerCase() : name))
    return `"${name}" is reserved (it collides with a file or directory under every profile root)`;
  return undefined;
}

export function isDefaultProfile(profile: string): boolean {
  return foldsCase() ? profile.toLowerCase() === DEFAULT_PROFILE : profile === DEFAULT_PROFILE;
}

export function profileDir(profile: string): string {
  return isDefaultProfile(profile) ? getBaseConfigDir() : join(getBaseConfigDir(), profile);
}

export function getConfigDir(): string {
  return profileDir(activeProfile());
}

export function getMemoriesDir(configDir: string = getConfigDir()): string {
  return join(configDir, MEMORIES_DIRNAME);
}

export function getAgentsDir(configDir: string = getConfigDir()): string {
  return join(configDir, AGENTS_DIRNAME);
}

export function getSkillsDir(configDir: string = getConfigDir()): string {
  return join(configDir, SKILLS_DIRNAME);
}

export function getRulesDir(configDir: string = getConfigDir()): string {
  return join(configDir, RULES_DIRNAME);
}

export function getMcpDir(configDir: string = getConfigDir()): string {
  return join(configDir, MCP_DIRNAME);
}

export function getHooksDir(configDir: string = getConfigDir()): string {
  return join(configDir, HOOKS_DIRNAME);
}

export function getPendingDir(configDir: string = getConfigDir()): string {
  return join(configDir, PENDING_DIRNAME);
}

export function getTrajectoriesDir(configDir: string = getConfigDir()): string {
  return join(configDir, TRAJECTORIES_DIRNAME);
}

export function getPlansDir(configDir: string = getConfigDir()): string {
  return join(configDir, PLANS_DIRNAME);
}

export function getDatabasePath(configDir: string = getConfigDir()): string {
  return join(configDir, DATABASE_FILENAME);
}

export function getDaemonDescriptorPath(configDir: string = getConfigDir()): string {
  return join(configDir, DAEMON_DESCRIPTOR_FILENAME);
}

export function getDaemonLockPath(configDir: string = getConfigDir()): string {
  return join(configDir, DAEMON_LOCK_FILENAME);
}
