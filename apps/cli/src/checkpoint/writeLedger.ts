import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";

function ledgerPath(storeDir: string): string {
  return join(storeDir, "ledger.json");
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function loadLedger(storeDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(storeDir), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

export function recordWrite(storeDir: string, absolutePath: string, content: string): void {
  const ledger = loadLedger(storeDir);
  ledger[absolutePath] = hash(content);
  atomicWriteFile(ledgerPath(storeDir), JSON.stringify(ledger));
}

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
