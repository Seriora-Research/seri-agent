import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

const MAX_RENAME_ATTEMPTS = 5;
const RETRY_DELAY_MS = 20;

function isReservedName(path: string): boolean {
  const name = basename(path, extname(path)).toUpperCase();
  return RESERVED_NAMES.has(name);
}

function detectEol(path: string): "LF" | "CRLF" {
  if (!existsSync(path)) return "LF";
  return readFileSync(path, "utf8").includes("\r\n") ? "CRLF" : "LF";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM";
}

export function writeFile(
  path: string,
  content: string,
  opts?: { eol?: "LF" | "CRLF" },
  renameFn: typeof renameSync = renameSync,
): void {
  if (process.platform === "win32" && isReservedName(path)) {
    throw new Error(`Cannot write to reserved device name: ${basename(path)}`);
  }

  const eol = opts?.eol ?? detectEol(path);
  const lf = content.replace(/\r\n/g, "\n");
  const finalContent = eol === "CRLF" ? lf.replace(/\n/g, "\r\n") : lf;

  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  // dirname("somefile.txt") is ".", the cwd — it always exists, and Bun's mkdirSync
  // throws EEXIST for it on Windows (unlike Node, which no-ops), so skip the call entirely.
  if (dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(tempPath, finalContent, "utf8");

  for (let attempt = 1; attempt <= MAX_RENAME_ATTEMPTS; attempt++) {
    try {
      renameFn(tempPath, path);
      return;
    } catch (err) {
      if (attempt === MAX_RENAME_ATTEMPTS || !isRetryableError(err)) {
        unlinkSync(tempPath);
        throw err;
      }
      sleepSync(RETRY_DELAY_MS);
    }
  }
}
