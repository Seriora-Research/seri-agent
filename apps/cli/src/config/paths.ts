import { homedir } from "node:os";
import { join } from "node:path";
import { AUTH_FILENAME } from "../auth/authStore";
import { PERMISSIONS_FILENAME } from "../permissions/store";
import { CONFIG_FILENAME } from "./config";

// Today's whole getConfigDir(), byte-for-byte, renamed. Unprofiled: the vendored-rg cache and
// nothing else lives here. Throws on win32 when LOCALAPPDATA is unset — this is the documented
// fallback runRipgrep.ts's detectRg() catches, not an oversight; see paths.test.ts.
export function getBaseConfigDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA environment variable is not set");
    return join(localAppData, "seri");
  }
  return join(process.env.HOME || homedir(), ".seri");
}

export const DEFAULT_PROFILE = "default";

// The full names of every sibling a profile directory would collide with under the default root.
// The three file-backed entries are read from the file that owns them (config.json, auth.json,
// permissions.yaml), so this set cannot drift out of sync with the literal each of those modules
// actually writes. sessions/, checkpoints/, rg/ (the shared vendored-rg cache) and bin/
// (install.ps1 installs the Windows binary to %LOCALAPPDATA%\seri\bin) have no single file that
// already owns them, so they stay literals here.
//
// Built lazily, on first use, rather than as a module-top-level constant: config.ts imports
// getConfigDir from THIS module (its loadConfig/setConfigValue/unsetConfigValue defaults), so
// config.ts and paths.ts form a real load cycle. Reading CONFIG_FILENAME at paths.ts's own
// top level hits config.ts's binding before config.ts's body has executed and throws — reproduced
// live, `bun run src/cli.ts --version` crashed at import time with "Cannot access 'CONFIG_FILENAME'
// before initialization". Deferring the read to first call, well after the whole module graph has
// finished loading, is the same trick config.ts's own default parameters already rely on for the
// opposite direction of this cycle.
let reservedProfileNames: ReadonlySet<string> | undefined;
export function getReservedProfileNames(): ReadonlySet<string> {
  reservedProfileNames ??= new Set([CONFIG_FILENAME, AUTH_FILENAME, PERMISSIONS_FILENAME, "sessions", "checkpoints", "rg", "bin"]);
  return reservedProfileNames;
}

// Module state, deliberately: getConfigDir() has callers (loadVerifyConfig, getApiKey) that
// receive no configDir parameter and cannot cheaply be given one, so threading a resolved
// directory through every call site would be a much larger diff than one indirection. Keeping the
// active profile here instead of on the argument parser also means SERI_PROFILE is READ on any
// path that never went through parseCliArgs (tests today, a future TUI entry point tomorrow) — but
// not VALIDATED there: profileNameError() only runs from parseCliArgs today, so a non-CLI entry
// point that wants the same reserved-name/charset guarantees must call it itself before use.
let override: string | undefined;

// `||`, not `??`, so SERI_PROFILE="" reads as unset — matching config.ts's own deliberate `||`
// for SERI_MODEL/SERI_VERIFY_COMMAND.
function profileFromEnv(): string | undefined {
  return process.env.SERI_PROFILE || undefined;
}

// flag > env > default. `source` exists only so the usage error can name what to fix. This is the
// one place precedence is resolved — activeProfile() below calls it with `override` rather than
// re-deriving the same ladder, so a change here governs both the usage-error validation in
// parseCliArgs and the directory actually resolved at runtime.
export function resolveProfile(flagValue: string | undefined): { profile: string; source: "flag" | "env" | "default" } {
  if (flagValue !== undefined) return { profile: flagValue, source: "flag" };
  const envProfile = profileFromEnv();
  if (envProfile !== undefined) return { profile: envProfile, source: "env" };
  return { profile: DEFAULT_PROFILE, source: "default" };
}

function activeProfile(): string {
  return resolveProfile(override).profile;
}

// Called unconditionally, once, from run() — including with undefined. That is what stops one
// in-process run() invoked with --profile from leaking into the next one, since `bun test` runs
// many run() calls in a single process.
export function setProfileOverride(profile: string | undefined): void {
  override = profile;
}

// undefined = valid. Otherwise the human-readable reason, ready to interpolate into usageError.
export function profileNameError(name: string): string | undefined {
  // Stops a value like "../../etc" from being a path-traversal primitive: it is fed straight to
  // join() below.
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return `"${name}" may only contain letters, numbers, ".", "_" and "-"`;
  if (name === "." || name === "..") return `"${name}" is not a valid profile name`;
  // Case-folded: NTFS and APFS are case-insensitive by default, so --profile Sessions would
  // collide with sessions/ on the two platforms most users are on (same reasoning as
  // permissions/store.ts's projectKey).
  if (getReservedProfileNames().has(name.toLowerCase())) return `"${name}" is reserved (it collides with a file or directory under every profile root)`;
  return undefined;
}

// The profile root. Identical to getBaseConfigDir() under the default profile — no `default/`
// segment, so no existing user's data moves.
export function getConfigDir(): string {
  const profile = activeProfile();
  const base = getBaseConfigDir();
  return profile === DEFAULT_PROFILE ? base : join(base, profile);
}
