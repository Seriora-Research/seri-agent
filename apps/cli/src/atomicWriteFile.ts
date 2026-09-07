import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
















export function ensureOwnerOnlyDir(dir: string): boolean {
  // mkdirSync `mode` is a no-op on an existing dir; chmod is skipped on win32.
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined;
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  return created;
}












export function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);





  if (existsSync(dir)) {
    accessSync(dir, constants.W_OK);
  }
  ensureOwnerOnlyDir(dir);







  if (existsSync(path)) {
    accessSync(path, constants.W_OK);
  }
  sweepStaleTmp(dir, path);
  const tmpPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}

const TMP_SUFFIX_RE = /^\.(\d+)\.[0-9a-f]{8}\.tmp$/;














function sweepStaleTmp(dir: string, path: string): void {
  const prefix = basename(path);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const match = TMP_SUFFIX_RE.exec(name.slice(prefix.length));
    if (match === null) continue;
    if (isProcessAlive(Number(match[1]))) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {

    }
  }
}



function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
