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
  // Checked BEFORE mkdirSync/chmodSync below, which otherwise reset an existing directory back
  // to 0o700 unconditionally — chmod'ing a directory to sabotage a brand-new file's write (no
  // destination file exists yet for the check below to catch) would be silently undone by that
  // reset if checked any later. Only checked when the directory already exists — mkdirSync itself
  // is what creates one that doesn't, and there is nothing yet to have restricted permissions on.
  if (existsSync(dir)) {
    accessSync(dir, constants.W_OK);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  // Checked explicitly, before the write-tmp-then-rename below: rename(2) on POSIX only requires
  // write permission on the PARENT DIRECTORY, never on the destination file's own inode, so
  // renaming a tmp file over a chmod'd-read-only destination silently succeeds and overwrites it
  // — a real regression confirmed by CI (config.test.ts's own sabotage test: chmod 0o444 on
  // config.json used to make setConfigValues throw, and after the write-tmp-then-rename
  // consolidation it silently didn't). Only checked when the destination already exists — a
  // brand-new file has no permissions of its own yet to violate.
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

// The trade-off the non-colliding tmp name (above) accepted: a process killed between
// writeFileSync and renameSync leaves its tmp file behind forever, since every later write to the
// same path picks a fresh random name rather than colliding with (and so overwriting) the old
// one the way the previous fixed-name scheme did by accident. For config.json specifically, an
// orphan can hold API keys, so leaving it on disk indefinitely is a real cost, not just clutter.
//
// Only a tmp file whose OWN encoded pid is no longer a running process is deleted — never every
// `${path}.*.tmp` match unconditionally. A concurrent writer's tmp file (P2 mid-writeFileSync
// while P1 is running this sweep) matches the same glob and is NOT an orphan; deleting it out
// from under P2 would reintroduce, via cleanup, exactly the race the pid+random name exists to
// prevent (P2's later renameSync would then throw ENOENT for a tmp file that vanished mid-write).
// Best-effort throughout: a readdir/unlink failure (permissions, already gone) must not block the
// write this function was actually called to do.
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
      // Best-effort — see this function's own comment.
    }
  }
}

// The standard cross-platform "does this pid exist" trick: signal 0 sends nothing, so this never
// actually signals the process, only probes whether kill() would be able to find it.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
