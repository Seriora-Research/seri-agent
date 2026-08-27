import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { parseUsageReport, type UsageReport } from "./report";

export const USAGE_SNAPSHOT_FILENAME = "usage-snapshot.json";
export const USAGE_SNAPSHOT_TTL_MS = 60 * 60 * 1000;

export type UsageSnapshot = { fetchedAt: string; report: UsageReport };

export function usageSnapshotPath(configDir: string): string {
  return join(configDir, USAGE_SNAPSHOT_FILENAME);
}

export function readUsageSnapshot(configDir: string): UsageSnapshot | undefined {
  const path = usageSnapshotPath(configDir);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { fetchedAt?: unknown; report?: unknown };
    if (typeof raw.fetchedAt !== "string") return undefined;
    const report = parseUsageReport(raw.report);
    if (report === null) return undefined;
    return { fetchedAt: raw.fetchedAt, report };
  } catch {
    return undefined;
  }
}

export function writeUsageSnapshot(configDir: string, snapshot: UsageSnapshot): void {
  atomicWriteFile(usageSnapshotPath(configDir), JSON.stringify(snapshot));
}

export function clearUsageSnapshot(configDir: string): void {
  const path = usageSnapshotPath(configDir);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Best-effort: logout must still clear auth.json even if this file is stuck.
  }
}

export function snapshotIsFresh(snapshot: UsageSnapshot, now: Date = new Date()): boolean {
  const fetched = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetched)) return false;
  return now.getTime() - fetched < USAGE_SNAPSHOT_TTL_MS;
}
