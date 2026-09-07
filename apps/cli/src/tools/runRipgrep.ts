import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../../package.json";
import { onAbort } from "../abort";
import { getBaseConfigDir } from "../config/paths";
import rgAsset from "./rg-vendored.bin" with { type: "file" };
import { killOnFatalSignal } from "./spawnCollect";

const RG_TIMEOUT_MS = 30_000;

let resolution: string | undefined;

export function resolveRg(): string {
  resolution ??= detectRg();
  return resolution;
}

function detectRg(): string {
  try {
    const cached = rgCachePath();
    if (!isCachedRg(cached)) populateCache(cached);
    return cached;
  } catch {
    // tmpdir() can be noexec, so this fallback only covers an unwritable config dir, not a noexec cache.
    return extractToTemp();
  }
}

// bun compile embeds rg-vendored.bin at B:/~BUN/root, which is not a real path spawn can execute.
function rgCachePath(): string {
  const key = `${pkg.version}-${process.platform}-${process.arch}-${statSync(rgAsset).size}`;
  return join(getBaseConfigDir(), "rg", key, process.platform === "win32" ? "rg.exe" : "rg");
}

// exFAT (and rsync without -p) strips the exec bit while leaving size intact.
function isCachedRg(cached: string): boolean {
  if (!existsSync(cached)) return false;

  const stats = statSync(cached);
  return (
    stats.size === statSync(rgAsset).size &&
    (process.platform === "win32" || (stats.mode & 0o111) !== 0)
  );
}

// Windows MoveFileEx replace-existing returns EPERM on concurrent racers; adopt the winner.
function populateCache(cached: string): void {
  mkdirSync(dirname(cached), { recursive: true });
  const tmp = `${cached}.${process.pid}.tmp`;
  writeFileSync(tmp, readFileSync(rgAsset));
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  for (const attempt of [1, 2]) {
    try {
      renameSync(tmp, cached);
      return;
    } catch (error) {
      if (isCachedRg(cached)) break;
      if (attempt === 2) {
        rmSync(tmp, { force: true });
        throw error;
      }
    }
  }
  rmSync(tmp, { force: true });
}

function extractToTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-rg-"));
  const path = join(dir, process.platform === "win32" ? "rg.exe" : "rg");
  writeFileSync(path, readFileSync(rgAsset));
  if (process.platform !== "win32") chmodSync(path, 0o755);

  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows AV can hold the just-executed rg and EPERM this unlink.
    }
  });
  return path;
}

export function rgVersion(command: string): string {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: RG_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw new Error(`failed to run ${command}: ${result.error.message}`);

  const match = /^ripgrep (\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
  if (!match)
    throw new Error(
      `${command} is not ripgrep: --version printed ${JSON.stringify(result.stdout.split("\n")[0]?.trim())}`,
    );
  return `${match[1]}.${match[2]}.${match[3]}`;
}

const MAX_BUFFER_CHARS = 8 * 1024 * 1024;

const MAX_STDERR_CHARS = 30_000;

export const MAX_RESULTS = 100;

export const MAX_FILE_RESULTS = 250;

export function outputLines(stdout: string, truncated: boolean): string[] {
  const lines = stdout.split("\n").filter(Boolean);
  if (truncated) lines.pop();
  return lines;
}

export async function assertSearchPath(path: string): Promise<void> {
  try {
    // stat of an unreachable UNC/NFS share blocks the event loop for the mount timeout.
    await stat(path);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // rg exit 2 stderr is the OS's localized strerror, so a missing path is classified here, not by matching that string.
    if (code === "ENOENT") throw new Error(`Path not found: ${path}`);
    if (code === "EACCES" || code === "EPERM") throw new Error(`Permission denied: ${path}`);
    throw error;
  }
}

// spawnSync swallows SIGINT until rg finishes, so a search cannot be cancelled.
export function runRipgrep(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    // --no-config: rg otherwise reads RIPGREP_CONFIG_PATH / ~/.ripgreprc.
    const child = spawn(resolveRg(), ["--no-config", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      stdout += chunk;
      if (stdout.length >= MAX_BUFFER_CHARS) {
        truncated = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length >= MAX_STDERR_CHARS) return;
      stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RG_TIMEOUT_MS);

    const abort = onAbort(signal, () => child.kill("SIGKILL"));

    const untrack = killOnFatalSignal(() => child.kill("SIGKILL"));

    const settled = (): void => {
      clearTimeout(timer);
      abort.dispose();
      untrack();
    };

    child.on("error", (error) => {
      settled();
      reject(new Error(`failed to run rg: ${error.message}`));
    });

    child.on("close", (code) => {
      settled();
      if (abort.aborted()) {
        reject(new Error("cancelled"));
        return;
      }
      if (timedOut) {
        reject(new Error(`rg did not finish within ${RG_TIMEOUT_MS / 1000}s and was killed`));
        return;
      }
      if (truncated) {
        resolve({ stdout, truncated: true });
        return;
      }
      // rg exits 1 when there are no matches.
      if (code !== 0 && code !== 1) {
        reject(new Error(`rg exited with code ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, truncated: false });
    });
  });
}
