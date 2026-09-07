import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { getCachedEol, setCachedEol } from "./eolCache";

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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM";
}

export type WriteFileOutput = { previous: string | null };

export function writeFile(
  path: string,
  content: string,
  opts?: { eol?: "LF" | "CRLF" },
  renameFn: typeof renameSync = renameSync,
): WriteFileOutput {
  if (process.platform === "win32" && isReservedName(path)) {
    throw new Error(`Cannot write to reserved device name: ${basename(path)}`);
  }

  const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  const eol =
    opts?.eol ??
    getCachedEol(path) ??
    (previous !== null && previous.includes("\r\n") ? "CRLF" : "LF");
  const lf = content.replace(/\r\n/g, "\n");
  const finalContent = eol === "CRLF" ? lf.replace(/\n/g, "\r\n") : lf;

  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  // Bun mkdirSync throws EEXIST for dirname "." on Windows; Node no-ops.
  if (dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(tempPath, finalContent, "utf8");

  for (let attempt = 1; attempt <= MAX_RENAME_ATTEMPTS; attempt++) {
    try {
      renameFn(tempPath, path);
      setCachedEol(path, eol);
      return { previous };
    } catch (err) {
      if (attempt === MAX_RENAME_ATTEMPTS || !isRetryableError(err)) {
        unlinkSync(tempPath);
        throw err;
      }
      sleepSync(RETRY_DELAY_MS);
    }
  }
  throw new Error("writeFile: rename retries exhausted");
}
