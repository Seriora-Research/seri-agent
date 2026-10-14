import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { clearEolCache } from "./eolCache";
import { type ProcessResult, spawnCollect } from "./spawnCollect";
import { ToolSpawnEnv } from "./toolSpawnEnv";

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

function daemonBash(): string {
  const detected = detectBash();
  if (!detected.available) throw new Error("bash is not available on this system");
  return detected.command;
}

export async function runBash(
  command: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  cwd?: string,
  env: ToolSpawnEnv = ToolSpawnEnv.inherited,
): Promise<ProcessResult> {
  const bash = env.resolveExecutable("bash", daemonBash);

  try {
    // pkill -f matches -c argv on Linux procps-ng, so POSIX evals the script from fd 3 with stdin ignored.
    // win32 Git Bash + bash -s hung the tree-kill timeout path, so win32 keeps -c.
    if (process.platform === "win32") {
      return await spawnCollect(bash, ["-c", command], timeoutMs, signal, cwd, undefined, env);
    }
    const script = command.endsWith("\n") ? command : `${command}\n`;
    return await spawnCollect(
      bash,
      ["-c", 'eval "$(cat <&3)"'],
      timeoutMs,
      signal,
      cwd,
      { fd3: script },
      env,
    );
  } finally {
    clearEolCache();
  }
}
