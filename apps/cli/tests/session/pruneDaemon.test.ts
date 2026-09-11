import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_FILENAME, SessionDatabase } from "../../src/session/database";
import type { SessionState } from "../../src/session/session";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-09-11T00:00:00.000Z");
const CUTOFF_MS = NOW_MS - 30 * DAY_MS;

let configDir: string;

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function openDir(): string {
  configDir = mkdtempSync(join(tmpdir(), "seri-prune-daemon-"));
  return configDir;
}

function session(id: string, messages: unknown[] = [{ role: "user", content: id }]): SessionState {
  return {
    id,
    cwd: "/repo",
    systemPrompt: "",
    permissionMode: "read-only",
    messages,
  };
}

function ageSession(id: string, updatedAtMs: number): void {
  const raw = new Database(join(configDir, DATABASE_FILENAME));
  raw.query("UPDATE sessions SET updated_at_ms = ? WHERE id = ?").run(updatedAtMs, id);
  raw.close();
}

function markScheduleRunning(id: string): void {
  const raw = new Database(join(configDir, DATABASE_FILENAME));
  raw.query("UPDATE schedules SET running = 1 WHERE id = ?").run(id);
  raw.close();
}

function insertSchedule(database: SessionDatabase, id = "sched"): void {
  database.insertSchedule({
    id,
    task: "report ready",
    cwd: "/repo",
    timingJson: JSON.stringify({ kind: "interval", everySeconds: 60 }),
    nextRunAtMs: NOW_MS,
    enabled: 1,
    createdAt: new Date(NOW_MS).toISOString(),
  });
}

function fireRun(
  database: SessionDatabase,
  opts: { runId: string; sessionId: string; scheduleId?: string; startedAt?: string },
): void {
  database.commitScheduleFire(
    {
      id: opts.runId,
      scheduleId: opts.scheduleId ?? "sched",
      sessionId: opts.sessionId,
      status: "complete",
      response: "ok",
      error: null,
      startedAt: opts.startedAt ?? new Date(NOW_MS - 31 * DAY_MS).toISOString(),
      finishedAt: new Date(NOW_MS - 31 * DAY_MS).toISOString(),
    },
    NOW_MS,
  );
}

describe("SessionDatabase.pruneDaemonRetention", () => {
  test("deletes a stale scheduled session, its messages, and its schedule_runs row", () => {
    openDir();
    const database = new SessionDatabase(configDir);
    try {
      insertSchedule(database);
      database.saveSession(session("stale-fire"));
      database.saveSession(session("fresh-fire"));
      fireRun(database, { runId: "run-stale", sessionId: "stale-fire" });
      fireRun(database, {
        runId: "run-fresh",
        sessionId: "fresh-fire",
        startedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      });
      ageSession("stale-fire", NOW_MS - 31 * DAY_MS);
      ageSession("fresh-fire", NOW_MS - DAY_MS);

      expect(database.pruneDaemonRetention({ cutoffMs: CUTOFF_MS })).toEqual(["stale-fire"]);
      expect(database.loadSession("stale-fire")).toBeUndefined();
      expect(database.loadSession("fresh-fire")?.id).toBe("fresh-fire");
      expect(database.listScheduleRuns("sched").map((row) => row.id)).toEqual(["run-fresh"]);
      expect(database.getSchedule("sched")?.id).toBe("sched");
      expect(database.searchSessions("stale-fire")).toEqual([]);
      expect(database.searchSessions("fresh-fire")).toMatchObject([
        { sessionId: "fresh-fire", text: "fresh-fire" },
      ]);
    } finally {
      database.close();
    }
  });

  test("leaves a TUI session that is older than the cutoff", () => {
    openDir();
    const database = new SessionDatabase(configDir);
    try {
      database.saveSession(session("tui", [{ role: "user", content: "interactive transcript" }]));
      ageSession("tui", NOW_MS - 90 * DAY_MS);

      expect(database.pruneDaemonRetention({ cutoffMs: CUTOFF_MS })).toEqual([]);
      expect(database.loadSession("tui")?.messages).toEqual([
        { role: "user", content: "interactive transcript" },
      ]);
    } finally {
      database.close();
    }
  });

  test("deletes a stale HTTP daemon session, its turns, and daemon_events", () => {
    openDir();
    const database = new SessionDatabase(configDir);
    try {
      database.saveSession(session("http-old"));
      database.insertTurn("turn-old", "http-old", new Date(NOW_MS - 40 * DAY_MS).toISOString());
      database.appendDaemonEvent("turn-old", 1, { type: "turn-complete", exitCode: 0 });
      database.finishTurn("turn-old", new Date(NOW_MS - 40 * DAY_MS).toISOString());
      ageSession("http-old", NOW_MS - 40 * DAY_MS);

      expect(database.pruneDaemonRetention({ cutoffMs: CUTOFF_MS })).toEqual(["http-old"]);
      expect(database.loadSession("http-old")).toBeUndefined();
      expect(database.hasTurn("turn-old")).toBe(false);
      expect(database.listDaemonEventsAfter("turn-old", 0)).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("a live schedule does not pin its stale prior fires", () => {
    openDir();
    const database = new SessionDatabase(configDir);
    try {
      insertSchedule(database);
      database.saveSession(session("stale-fire"));
      fireRun(database, { runId: "run-stale", sessionId: "stale-fire" });
      ageSession("stale-fire", NOW_MS - 31 * DAY_MS);
      markScheduleRunning("sched");
      expect(database.getSchedule("sched")?.running).toBe(true);

      expect(database.pruneDaemonRetention({ cutoffMs: CUTOFF_MS })).toEqual(["stale-fire"]);
      expect(database.loadSession("stale-fire")).toBeUndefined();
      expect(database.listScheduleRuns("sched")).toEqual([]);
      expect(database.getSchedule("sched")?.running).toBe(true);
    } finally {
      database.close();
    }
  });

  test("keepSessionId and a running turn survive even when aged out", () => {
    openDir();
    const database = new SessionDatabase(configDir);
    try {
      insertSchedule(database);
      database.saveSession(session("kept-fire"));
      fireRun(database, { runId: "run-kept", sessionId: "kept-fire" });
      ageSession("kept-fire", NOW_MS - 31 * DAY_MS);

      database.saveSession(session("live-turn"));
      database.insertTurn(
        "turn-running",
        "live-turn",
        new Date(NOW_MS - 40 * DAY_MS).toISOString(),
      );
      ageSession("live-turn", NOW_MS - 40 * DAY_MS);

      expect(
        database.pruneDaemonRetention({ cutoffMs: CUTOFF_MS, keepSessionId: "kept-fire" }),
      ).toEqual([]);
      expect(database.loadSession("kept-fire")?.id).toBe("kept-fire");
      expect(database.listScheduleRuns("sched").map((row) => row.id)).toEqual(["run-kept"]);
      expect(database.loadSession("live-turn")?.id).toBe("live-turn");
      expect(database.hasTurn("turn-running")).toBe(true);
    } finally {
      database.close();
    }
  });

  test("a second prune is a no-op and the next open still passes foreign-key checks", () => {
    openDir();
    const database = new SessionDatabase(configDir);
    try {
      insertSchedule(database);
      database.saveSession(session("gone"));
      fireRun(database, { runId: "run-gone", sessionId: "gone" });
      ageSession("gone", NOW_MS - 31 * DAY_MS);
      expect(database.pruneDaemonRetention({ cutoffMs: CUTOFF_MS })).toEqual(["gone"]);
      expect(database.pruneDaemonRetention({ cutoffMs: CUTOFF_MS })).toEqual([]);
    } finally {
      database.close();
    }
    const reopened = new SessionDatabase(configDir);
    try {
      expect(reopened.getPragmas().userVersion).toBe(5);
      expect(reopened.loadSession("gone")).toBeUndefined();
    } finally {
      reopened.close();
    }
  });
});
