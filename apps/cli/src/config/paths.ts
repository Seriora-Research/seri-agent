import { homedir } from "node:os";
import { join } from "node:path";
import { AUTH_FILENAME } from "../auth/authStore";
import { foldsCase } from "../caseFold";
import { PERMISSIONS_FILENAME } from "../permissions/store";
import { CONFIG_FILENAME } from "./config";

// Unprofiled: the vendored-rg cache and nothing else lives here. Platform-independent by
// design: no win32 branch, no throw path.
export function getBaseConfigDir(): string {
  return join(process.env.HOME || homedir(), ".seri");
}

export const DEFAULT_PROFILE = "default";

// Stage 6b's two profile-root directories — kept as named consts, not inline string literals, so
// getReservedProfileNames()'s set below and getMemoriesDir/getPendingDir's own accessors read from
// one source and cannot drift apart from each other, the same anti-drift discipline this file's
// own header comment already applies to CONFIG_FILENAME/AUTH_FILENAME/PERMISSIONS_FILENAME.
export const MEMORIES_DIRNAME = "memories";
export const PENDING_DIRNAME = "pending";

// The full names of every sibling a profile directory would collide with under the default root.
// The three file-backed entries are read from the file that owns them (config.json, auth.json,
// permissions.yaml), so this set cannot drift out of sync with the literal each of those modules
// actually writes. sessions/, checkpoints/, rg/ (the shared vendored-rg cache) and bin/
// (install.ps1 installs the Windows binary to ~\.seri\bin) have no single file that
// already owns them, so they stay literals here. Caveat: install.ps1 resolves that path from
// $env:USERPROFILE, not $HOME, so a user with HOME set to something other than USERPROFILE on
// Windows gets two different roots — the binary under %USERPROFILE%\.seri\bin, config/sessions
// under $HOME\.seri.
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
  reservedProfileNames ??= new Set([
    CONFIG_FILENAME,
    AUTH_FILENAME,
    PERMISSIONS_FILENAME,
    "sessions",
    "checkpoints",
    "rg",
    "bin",
    MEMORIES_DIRNAME,
    PENDING_DIRNAME,
  ]);
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
export function resolveProfile(flagValue: string | undefined): {
  profile: string;
  source: "flag" | "env" | "default";
} {
  // Truthy, not `!== undefined`: `seri --profile "$UNSET_VAR" …` is a real shell pattern that
  // expands to an explicit empty string, and it should fall through the same way SERI_PROFILE=""
  // already does (profileFromEnv's `||`) rather than failing profileNameError's charset check.
  if (flagValue) return { profile: flagValue, source: "flag" };
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
  if (!/^[A-Za-z0-9._-]+$/.test(name))
    return `"${name}" may only contain letters, numbers, ".", "_" and "-"`;
  if (name === "." || name === "..") return `"${name}" is not a valid profile name`;
  // Case-folded only on win32/darwin — see caseFold.ts. NTFS and APFS are case-insensitive by
  // default, so --profile Sessions would collide with sessions/ there, but ext4 is case-sensitive
  // and folding unconditionally would reject a name that is genuinely distinct on Linux.
  if (getReservedProfileNames().has(foldsCase() ? name.toLowerCase() : name))
    return `"${name}" is reserved (it collides with a file or directory under every profile root)`;
  return undefined;
}

// The profile root. Identical to getBaseConfigDir() under the default profile — no `default/`
// segment, so no existing user's data moves.
export function getConfigDir(): string {
  const profile = activeProfile();
  const base = getBaseConfigDir();
  // Same fold as profileNameError above: --profile Default must resolve to the base root on
  // win32/darwin exactly like --profile default does, not silently create a separate `Default/`
  // directory because this comparison forgot the case-insensitivity the reserved-name check
  // already accounts for.
  const isDefault = foldsCase()
    ? profile.toLowerCase() === DEFAULT_PROFILE
    : profile === DEFAULT_PROFILE;
  return isDefault ? base : join(base, profile);
}

// Stage 6b: where the three persistent-memory files (USER.md, MEMORY.md, <project>/MEMORY.md)
// live, and where a write is staged before /memory approve applies it. Both default to
// getConfigDir() like every other profile-root accessor, but take an explicit configDir too — the
// memory store is built and tested against an mkdtempSync fixture, never the real profile root.
export function getMemoriesDir(configDir: string = getConfigDir()): string {
  return join(configDir, MEMORIES_DIRNAME);
}

export function getPendingDir(configDir: string = getConfigDir()): string {
  return join(configDir, PENDING_DIRNAME);
}
