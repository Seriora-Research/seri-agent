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

let bashResolution: { command: string; available: boolean } | undefined;

// Resolved once per process (mirrors runRipgrep.ts's resolveRg/detectRg): findOnPath walks every
// PATH directory, so isBashAvailable and resolveBashCommand each calling it independently scanned
// PATH twice per runBash call for a result that cannot change mid-process.
function detectBash(): { command: string; available: boolean } {
  const found = findOnPath("bash") ?? WIN32_GIT_BASH_PATHS.find(existsSync);
  return { command: found ?? "bash", available: found !== undefined };
}

export function isBashAvailable(): boolean {
  bashResolution ??= detectBash();
  return bashResolution.available;
}

function resolveBashCommand(): string {
  bashResolution ??= detectBash();
  return bashResolution.command;
}

// isAvailable last, after the two parameters production actually passes, so that production reads
// runBash(command, timeoutMs, signal) — the same shape as runPowerShell — rather than threading an
// `undefined` past a test seam. The seam's cost belongs to the one test that overrides it.
export async function runBash(
  command: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  isAvailable: () => boolean = isBashAvailable,
): Promise<ProcessResult> {
  if (!isAvailable()) {
    throw new Error("bash is not available on this system");
  }

  try {
    return await spawnCollect(resolveBashCommand(), ["-c", command], timeoutMs, signal);
  } finally {
    // A command can touch any file, not just one readFile/writeFile already cached the EOL for —
    // and it may have changed a file's line endings before writeFile gets to it, so the whole cache
    // is invalidated rather than trusting whatever it held before this call ran.
    clearEolCache();
  }
}
