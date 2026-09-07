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

export function resolveBashCommand(): string {
  return detectBash().command;
}

export function _resetBashResolutionForTests(): void {
  bashResolution = undefined;
}

export function _detectBashForTests(find: () => string | undefined): {
  command: string;
  available: boolean;
} {
  return detectBash(find);
}

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
    clearEolCache();
  }
}
