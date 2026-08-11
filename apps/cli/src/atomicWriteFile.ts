import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// mkdir 0o700 + write-tmp + chmod 0o600 + rename — the shape permissions/store.ts's own
// writeDocument, config.ts's writeConfig, and memory/store.ts's applyWrite / memory/pending.ts's
// writePendingFile all independently reimplemented; the three memory/config writers share this
// one now (permissions/store.ts's own copy predates this consolidation and is out of scope).
//
// The tmp filename includes the PID and a random suffix, not just `${path}.tmp`: two concurrent
// seri processes against the same profile (a TUI session open plus a second terminal, both with
// the approval gate off) writing the SAME target file raced on a fixed tmp path — P2's write
// could truncate/overwrite the tmp file P1 was still writing, and P1's rename would then land
// content P1 never computed and never validated (e.g. against memory's own char cap). A
// non-colliding name removes the race outright rather than trying to detect it.
export function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const tmpPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}
