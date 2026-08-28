import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { clearEolCache } from "./eolCache";
import { type ProcessResult, spawnCollect } from "./spawnCollect";

const WIN32_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
];

function findOnPath(command: string): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  const names = process.platform === "win32" ? [`${command}.exe`, command] : [command];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

let bashResolution: { command: string; available: true } | undefined;

function findBash(): string | undefined {
  return (
    findOnPath("bash") ??
    (process.platform === "win32" ? WIN32_GIT_BASH_PATHS.find(existsSync) : undefined)
  );
}

// Resolved once per process (mirrors runRipgrep.ts's resolveRg/detectRg): findOnPath walks every
// PATH directory, so isBashAvailable and resolveBashCommand each calling it independently scanned
// PATH twice per runBash call for a result that cannot change mid-process. Only the FOUND case is
// cached, deliberately: a long-running TUI session can outlive a PATH fix (Git Bash installed, or
// PATH corrected, without restarting seri) — caching "not found" too would make that recovery
// invisible for the rest of the process. Every other tool call in this codebase is either a single
// process (runBash's own cost is trivial there) or has no working alternative to retry towards, so
// re-scanning PATH on each failed call, rather than latching the failure, is the one case where the
// asymmetry is worth it: success is cached because it cannot un-become true, failure is not because
// it can.
//
// `find` is a seam, not a production knob: every real call site below omits it and gets the real
// findBash. A test proving the negative case recovers needs to simulate "not found anywhere"
// without a machine that genuinely lacks Git Bash at WIN32_GIT_BASH_PATHS, and _detectBashForTests
// is how it reaches this without changing isBashAvailable/resolveBashCommand's own signatures.
function detectBash(find: () => string | undefined = findBash): {
  command: string;
  available: boolean;
} {
  if (bashResolution !== undefined) return bashResolution;
  const found = find();
  if (found === undefined) return { command: "bash", available: false };
  bashResolution = { command: found, available: true };
  return bashResolution;
}

export function isBashAvailable(): boolean {
  return detectBash().available;
}

function resolveBashCommand(): string {
  return detectBash().command;
}

// Test-only, mirrors model-catalog's resetCatalogCache: the cache is deliberately unresettable
// from production code (runRipgrep.ts's resolveRg has the identical comment on why), so this is
// the seam a test uses to prove a call after a reset re-runs `find` instead of trusting a stale
// negative result.
export function _resetBashResolutionForTests(): void {
  bashResolution = undefined;
}

export function _detectBashForTests(find: () => string | undefined): {
  command: string;
  available: boolean;
} {
  return detectBash(find);
}

// isAvailable last, after the two parameters production actually passes, so that production reads
// runBash(command, timeoutMs, signal) — the same shape as runPowerShell — rather than threading an
// `undefined` past a test seam. The seam's cost belongs to the one test that overrides it.
export async function runBash(
  command: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  isAvailable: () => boolean = isBashAvailable,
  cwd?: string,
): Promise<ProcessResult> {
  if (!isAvailable()) {
    throw new Error("bash is not available on this system");
  }

  try {
    return await spawnCollect(resolveBashCommand(), ["-c", command], timeoutMs, signal, cwd);
  } finally {
    // A command can touch any file, not just one readFile/writeFile already cached the EOL for —
    // and it may have changed a file's line endings before writeFile gets to it, so the whole cache
    // is invalidated rather than trusting whatever it held before this call ran.
    clearEolCache();
  }
}
