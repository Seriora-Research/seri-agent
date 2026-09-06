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

  // Accepted staleness, same direction as writeLedger.ts's read-modify-write race: the cache is
  // cleared after every seri-invoked bash/powershell call and after every restore (eolCache.ts's
  // own header comment), but a file rewritten by something entirely outside seri's own tool
  // calls — the user's editor, a file-watcher formatter — between a read and a later write is
  // invisible to either of those triggers. The cost is a wrong-but-still-consistent EOL
  // convention on the next write, not data loss, and paying disk detection on every write to close
  // a window this narrow would give up the read → write fast path this cache exists for.
  const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  const eol =
    opts?.eol ?? getCachedEol(path) ?? (previous !== null && previous.includes("\r\n") ? "CRLF" : "LF");
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
      // The file's EOL is now whatever was just written — cached so a read_file/write_file that
      // follows on the same path doesn't re-detect it from disk.
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
