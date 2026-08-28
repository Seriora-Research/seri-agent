import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export function pruneTrajectories(
  dir: string,
  opts: { now: Date; retentionDays: number; keepSessionId?: string },
): string[] {
  if (!existsSync(dir)) return [];
  const cutoff = opts.now.getTime() - opts.retentionDays * DAY_MS;
  const keepName = opts.keepSessionId !== undefined ? `${opts.keepSessionId}.jsonl` : undefined;
  const deleted: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    if (name === keepName) continue;
    const path = join(dir, name);
    if (statSync(path).mtimeMs < cutoff) {
      rmSync(path);
      deleted.push(path);
    }
  }
  return deleted;
}
