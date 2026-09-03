import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { configDirForStore, DATABASE_FILENAME, SessionDatabase } from "../session/database";

const DAY_MS = 24 * 60 * 60 * 1000;

export function pruneTrajectories(
  dir: string,
  opts: {
    now: Date;
    retentionDays: number;
    keepSessionId?: string;
    database?: SessionDatabase;
  },
): { files: string[]; sessions: string[] } {
  const cutoff = opts.now.getTime() - opts.retentionDays * DAY_MS;
  const files: string[] = [];
  if (existsSync(dir)) {
    const keepName = opts.keepSessionId !== undefined ? `${opts.keepSessionId}.jsonl` : undefined;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      if (name === keepName) continue;
      const path = join(dir, name);
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path);
        files.push(path);
      }
    }
  }
  const configDir = configDirForStore(dir, "trajectories");
  if (opts.database === undefined && !existsSync(join(configDir, DATABASE_FILENAME))) {
    return { files, sessions: [] };
  }
  const pruneOpts = {
    cutoff: new Date(cutoff).toISOString(),
    ...(opts.keepSessionId !== undefined ? { keepSessionId: opts.keepSessionId } : {}),
  };
  if (opts.database !== undefined) {
    return { files, sessions: opts.database.pruneTrajectories(pruneOpts) };
  }
  const database = new SessionDatabase(configDir);
  try {
    return { files, sessions: database.pruneTrajectories(pruneOpts) };
  } finally {
    database.close();
  }
}
