import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDatabase } from "../../src/session/database";
import { pruneTrajectories } from "../../src/trajectory/prune";
import {
  TRAJECTORY_SCHEMA_VERSION,
  type TrajectoryKind,
  type TrajectoryRecord,
} from "../../src/trajectory/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

function seedSession(
  database: SessionDatabase,
  sessionId: string,
  at: string,
  kind: TrajectoryKind = { kind: "done", reason: "no-tool-call" },
): void {
  database.appendTrajectory(
    {
      v: TRAJECTORY_SCHEMA_VERSION,
      kind: "header",
      sessionId,
      cwd: "/tmp/proj",
      startedAt: at,
    },
    {
      v: TRAJECTORY_SCHEMA_VERSION,
      ts: at,
      sessionId,
      actor: { type: "parent" },
      ...kind,
    } as Omit<TrajectoryRecord, "seq">,
  );
}

describe("pruneTrajectories", () => {
  test("deletes jsonl older than the window and keeps keepSessionId", () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-traj-prune-"));
    try {
      const oldPath = join(dir, "old.jsonl");
      const midPath = join(dir, "mid.jsonl");
      const livePath = join(dir, "live.jsonl");
      writeFileSync(oldPath, "{}\n");
      writeFileSync(midPath, "{}\n");
      writeFileSync(livePath, "{}\n");
      const now = new Date("2026-08-27T00:00:00Z");
      utimesSync(
        oldPath,
        new Date(now.getTime() - 31 * DAY_MS),
        new Date(now.getTime() - 31 * DAY_MS),
      );
      utimesSync(
        midPath,
        new Date(now.getTime() - 15 * DAY_MS),
        new Date(now.getTime() - 15 * DAY_MS),
      );
      utimesSync(livePath, now, now);
      writeFileSync(join(dir, "notes.txt"), "leave me");

      const pruned = pruneTrajectories(dir, { now, retentionDays: 30, keepSessionId: "live" });
      expect(pruned.files).toEqual([oldPath]);
      expect(readdirSync(dir).sort()).toEqual(["live.jsonl", "mid.jsonl", "notes.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing directory prunes nothing", () => {
    const parent = mkdtempSync(join(tmpdir(), "seri-traj-missing-"));
    try {
      expect(
        pruneTrajectories(join(parent, "missing"), {
          now: new Date(),
          retentionDays: 30,
        }),
      ).toEqual({ files: [], sessions: [] });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // SessionDatabase's busy_timeout is 5s, the same as bun's default test timeout. On Windows,
  // close() does not always release the sqlite file before pruneTrajectories opens a new
  // handle, so that constructor can wait the full busy timeout. These two tests close then
  // reopen by path and must outlive that wait.
  test(
    "deletes database sessions older than the window and keeps keepSessionId",
    () => {
      const configDir = mkdtempSync(join(tmpdir(), "seri-traj-db-prune-"));
      const dir = join(configDir, "trajectories");
      const now = new Date("2026-08-27T00:00:00Z");
      const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
      try {
        const database = new SessionDatabase(configDir);
        seedSession(database, "old", at(31));
        seedSession(database, "mid", at(15));
        seedSession(database, "live", at(40));
        database.close();

        const pruned = pruneTrajectories(dir, { now, retentionDays: 30, keepSessionId: "live" });
        expect(pruned.sessions).toEqual(["old"]);

        const after = new SessionDatabase(configDir);
        try {
          expect(after.readTrajectory("old")).toEqual([]);
          expect(after.readTrajectory("mid")).toHaveLength(2);
          expect(after.readTrajectory("live")).toHaveLength(2);
        } finally {
          after.close();
        }
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    },
    { timeout: 15_000 },
  );

  test(
    "a session is aged out on its newest record, not its oldest",
    () => {
      const configDir = mkdtempSync(join(tmpdir(), "seri-traj-db-newest-"));
      const dir = join(configDir, "trajectories");
      const now = new Date("2026-08-27T00:00:00Z");
      const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
      try {
        const database = new SessionDatabase(configDir);
        seedSession(database, "long-running", at(90));
        seedSession(database, "long-running", at(1), { kind: "retry", attempt: 1 });
        database.close();

        expect(pruneTrajectories(dir, { now, retentionDays: 30 }).sessions).toEqual([]);

        const after = new SessionDatabase(configDir);
        try {
          expect(after.readTrajectory("long-running")).toHaveLength(3);
        } finally {
          after.close();
        }
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    },
    { timeout: 15_000 },
  );

  test("no database means nothing to prune and none is created", () => {
    const configDir = mkdtempSync(join(tmpdir(), "seri-traj-db-absent-"));
    const dir = join(configDir, "trajectories");
    mkdirSync(dir);
    try {
      expect(pruneTrajectories(dir, { now: new Date(), retentionDays: 30 })).toEqual({
        files: [],
        sessions: [],
      });
      expect(readdirSync(configDir)).toEqual(["trajectories"]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
