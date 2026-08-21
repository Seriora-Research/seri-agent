import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";

// One entry per distinct absolute path ever written through write_file in the project's lifetime,
// and nothing ever removes an entry — pruneSessions (checkpoint.ts) prunes the session log and the
// shadow git history, not this file. Fine at realistic project sizes (one small JSON line per
// path, not per write), but worth stating: the ledger only ever grows.
function ledgerPath(storeDir: string): string {
  return join(storeDir, "ledger.json");
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// A corrupt or missing ledger fails SAFE, not open: "nothing is verified as seri-authored" only
// ever makes filterSafeToDelete MORE conservative — it skips more, never deletes more — the same
// "one warning, latch off, never silently over-delete" posture createCheckpointer's own error
// latch already applies to the rest of this subsystem. Valid-but-wrong-shaped JSON (`null`, an
// array, a bare number) is treated the same as a parse failure, not just a parse failure itself:
// `null[path]` throws in both recordWrite's write and filterSafeToDelete's read, and the latter
// has no try/catch around its call in restoreTo, so an unguarded `null` here would fail /undo
// outright instead of degrading to "nothing verified" the way this comment promises.
export function loadLedger(storeDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(storeDir), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

// Called only from write_file's own onAfterMutation hook, after the write has actually landed on
// disk — never for bash/powershell output. A shell command's target path(s) cannot be attributed
// without parsing the command it ran, and an entry recorded against a guess would let a future
// restore delete a file on the strength of a guess, which is worse than not recording it at all.
// `content` must be the exact bytes now on disk, EOL transform included — the bytes read back
// from disk once the write landed, not writeFile.ts's in-memory value — a hash of anything else
// can never match what filterSafeToDelete reads back, which would silently make every future
// restore of this path more conservative than it needs to be, never less safe, but silently wrong
// all the same.
export function recordWrite(storeDir: string, absolutePath: string, content: string): void {
  // Read-modify-write, not a transaction: two seri processes recording different paths for the
  // same project at nearly the same instant can each load the ledger before either writes it back,
  // and whichever atomicWriteFile call lands last silently drops the other's entry. Not fixed with
  // a lock, deliberately — the failure direction is the same accepted one as the case-folding note
  // on filterSafeToDelete below: the dropped path just has no ledger entry, which makes a later
  // restore preserve it rather than delete it, never the other way around. Locking a JSON
  // read-modify-write across processes for a race this narrow, whose worst case is already the
  // subsystem's own default-safe behaviour, would add real complexity for no change in outcome.
  const ledger = loadLedger(storeDir);
  ledger[absolutePath] = hash(content);
  // Atomic (temp file + rename), same as the rest of this checkpoint subsystem: a torn write here
  // (killed mid-write, disk full) would make the next loadLedger parse fail and return `{}`,
  // silently losing every previously-recorded write-provenance entry — still safe (filterSafeToDelete
  // fails toward preserving, never deleting) but a real loss of undo coverage for every file the
  // ledger already vouched for.
  atomicWriteFile(ledgerPath(storeDir), JSON.stringify(ledger));
}

// Hermes' (github.com/NousResearch/hermes-agent) positive-proof rule for the identical problem,
// ported: a candidate is safe to delete only when there is a ledger entry for it AND the file's
// CURRENT on-disk content still hashes to that entry. No entry (never written through write_file,
// or written before this store had a ledger at all) and a hash mismatch (edited by the user, by a
// shell command, or by anything else since) both fail toward PRESERVING the file — never toward
// deleting it — which is the whole difference from asking planRestore's tree diff alone, which
// only knows a path is absent from the target tree and has no idea whether seri ever touched it.
export function filterSafeToDelete(
  storeDir: string,
  worktree: string,
  candidateRelativePaths: string[],
): string[] {
  // A case-insensitive filesystem with a case-variant declared path, or a symlinked project root
  // where realpath resolution differs from process.cwd() (recordWrite's own resolve() call site),
  // can make this exact-string join miss an entry that IS on disk. Always degrades in the safe
  // direction: a miss here fails the `expected === undefined` check below, so the file is preserved
  // and reported via RestorePlan.preserved rather than silently deleted — a known, accepted
  // limitation, not a bug.
  const ledger = loadLedger(storeDir);
  return candidateRelativePaths.filter((path) => {
    const absolute = join(worktree, path);
    const expected = ledger[absolute];
    if (expected === undefined) return false;
    try {
      return hash(readFileSync(absolute, "utf8")) === expected;
    } catch {
      return false;
    }
  });
}
