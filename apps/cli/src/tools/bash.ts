import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type ProcessResult, spawnCollect } from "./spawnCollect";

const WIN32_GIT_BASH_PATHS = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"];

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

export function isBashAvailable(): boolean {
  if (findOnPath("bash")) return true;
  return process.platform === "win32" && WIN32_GIT_BASH_PATHS.some(existsSync);
}

function resolveBashCommand(): string {
  return findOnPath("bash") ?? WIN32_GIT_BASH_PATHS.find(existsSync) ?? "bash";
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

  return spawnCollect(resolveBashCommand(), ["-c", command], timeoutMs, signal);
}
