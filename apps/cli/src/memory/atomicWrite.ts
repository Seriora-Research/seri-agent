import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// mkdir 0o700 + write-tmp + chmod 0o600 + rename — the shape of permissions/store.ts's own
// writeDocument, shared by store.ts's applyWrite and pending.ts's writePendingFile (the two
// memory/ writers this stage introduced; every other copy of this pattern in the repo predates
// this PR and is out of scope here).
//
// The tmp filename includes the PID and a random suffix, not just `${path}.tmp`: two concurrent
// seri processes against the same profile (a TUI session open plus a second terminal, both with
// the approval gate off) writing the SAME live file raced on a fixed tmp path — P2's write could
// truncate/overwrite the tmp file P1 was still writing, and P1's rename would then land content
// P1 never computed and never validated against its own cap. A non-colliding name removes the
// race outright rather than trying to detect it.
export function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const tmpPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}
