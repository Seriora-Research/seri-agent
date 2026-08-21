import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function ledgerPath(storeDir: string): string {
  return join(storeDir, "ledger.json");
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// A corrupt or missing ledger fails SAFE, not open: "nothing is verified as seri-authored" only
// ever makes filterSafeToDelete MORE conservative — it skips more, never deletes more — the same
// "one warning, latch off, never silently over-delete" posture createCheckpointer's own error
// latch already applies to the rest of this subsystem.
export function loadLedger(storeDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(ledgerPath(storeDir), "utf8"));
  } catch {
    return {};
  }
}

// Called only from write_file's own onAfterMutation hook, after the write has actually landed on
// disk — never for bash/powershell output. A shell command's target path(s) cannot be attributed
// without parsing the command it ran, and an entry recorded against a guess would let a future
// restore delete a file on the strength of a guess, which is worse than not recording it at all.
// `content` must be the exact bytes now on disk, EOL transform included (writeFile.ts's own
// `finalContent`) — a hash of anything else can never match what filterSafeToDelete reads back,
// which would silently make every future restore of this path more conservative than it needs to
// be, never less safe, but silently wrong all the same.
export function recordWrite(storeDir: string, absolutePath: string, content: string): void {
  const ledger = loadLedger(storeDir);
  ledger[absolutePath] = hash(content);
  writeFileSync(ledgerPath(storeDir), JSON.stringify(ledger));
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
