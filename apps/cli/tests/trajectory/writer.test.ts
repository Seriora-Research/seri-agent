import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_FILENAME, SessionDatabase } from "../../src/session/database";
import { createTrajectoryWriter, readTrajectory } from "../../src/trajectory/writer";

function writerOpts(
  dir: string,
  extras: Partial<Parameters<typeof createTrajectoryWriter>[0]> = {},
) {
  return {
    dir,
    sessionId: "sess-1",
    cwd: "/tmp/proj",
    enabled: true,
    retentionDays: 30,
    onWarning: () => {},
    ...extras,
  };
}

describe("createTrajectoryWriter SQLite persistence", () => {
  test("writes live records to SQLite with stable sequence and creates no JSONL", () => {
    const configDir = mkdtempSync(join(tmpdir(), "seri-traj-writer-"));
    const dir = join(configDir, "trajectories");
    try {
      const writer = createTrajectoryWriter(writerOpts(dir));
      writer.recordLoopEvent({ type: "done", reason: "no-tool-call" });
      writer.recordLoopEvent({ type: "retry", attempt: 1 });

      expect(existsSync(join(dir, "sess-1.jsonl"))).toBe(false);
      expect(existsSync(join(configDir, DATABASE_FILENAME))).toBe(true);
      const records = readTrajectory(join(dir, "sess-1.jsonl"));
      expect(records[0]).toMatchObject({ v: 1, kind: "header", sessionId: "sess-1" });
      expect(records[1]).toMatchObject({ kind: "done", seq: 1, reason: "no-tool-call" });
      expect(records[2]).toMatchObject({ kind: "retry", seq: 2, attempt: 1 });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("reopening a writer continues sequence without duplicating the header", () => {
    const configDir = mkdtempSync(join(tmpdir(), "seri-traj-reopen-"));
    const dir = join(configDir, "trajectories");
    try {
      createTrajectoryWriter(writerOpts(dir)).recordLoopEvent({
        type: "done",
        reason: "no-tool-call",
      });
      createTrajectoryWriter(writerOpts(dir)).recordLoopEvent({ type: "retry", attempt: 1 });

      const records = readTrajectory(join(dir, "sess-1.jsonl"));
      expect(records.filter((value) => (value as { kind: string }).kind === "header")).toHaveLength(
        1,
      );
      expect(records.slice(1)).toMatchObject([
        { seq: 1, kind: "done" },
        { seq: 2, kind: "retry" },
      ]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("ignored loop events do not create storage or consume sequence", () => {
    const configDir = mkdtempSync(join(tmpdir(), "seri-traj-delta-"));
    const dir = join(configDir, "trajectories");
    try {
      const writer = createTrajectoryWriter(writerOpts(dir));
      writer.recordLoopEvent({ type: "text-delta", text: "hi" });
      expect(readdirSync(configDir)).toEqual([]);

      writer.recordLoopEvent({ type: "done", reason: "no-tool-call" });
      expect(readTrajectory(join(dir, "sess-1.jsonl"))[1]).toMatchObject({
        kind: "done",
        seq: 1,
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("preserves child and archivist actor records", () => {
    const configDir = mkdtempSync(join(tmpdir(), "seri-traj-actors-"));
    const dir = join(configDir, "trajectories");
    try {
      const writer = createTrajectoryWriter(writerOpts(dir));
      writer.recordChildEvent({
        childId: "turn:0",
        role: "explore",
        goal: "inspect",
        event: { type: "retry", attempt: 2 },
      });
      writer.recordArchivist({
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          totalTokens: 3,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
        cost: undefined,
      });

      expect(readTrajectory(join(dir, "sess-1.jsonl")).slice(1)).toMatchObject([
        {
          kind: "retry",
          actor: { type: "child", childId: "turn:0", role: "explore" },
        },
        { kind: "usage", source: "archivist", actor: { type: "archivist" } },
      ]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("disabled writer creates neither a database nor trajectory directory", () => {
    const configDir = mkdtempSync(join(tmpdir(), "seri-traj-disabled-"));
    try {
      const writer = createTrajectoryWriter(
        writerOpts(join(configDir, "trajectories"), { enabled: false }),
      );
      writer.recordLoopEvent({ type: "done", reason: "no-tool-call" });
      expect(readdirSync(configDir)).toEqual([]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

test("legacy trajectory JSONL imports once and remains byte-identical", () => {
  const configDir = mkdtempSync(join(tmpdir(), "seri-traj-import-"));
  const dir = join(configDir, "trajectories");
  mkdirSync(dir);
  const path = join(dir, "legacy.jsonl");
  const header = {
    v: 1,
    kind: "header",
    sessionId: "legacy",
    cwd: "/old",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  const record = {
    v: 1,
    ts: "2026-01-01T00:00:01.000Z",
    seq: 1,
    sessionId: "legacy",
    actor: { type: "parent" },
    kind: "done",
    reason: "no-tool-call",
  };
  writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(record)}\n`);
  const snapshot = readFileSync(path);
  try {
    const database = new SessionDatabase(configDir);
    try {
      database.importLegacyTrajectories(dir);
      database.importLegacyTrajectories(dir);
      expect(database.readTrajectory("legacy")).toEqual([header, record]);
    } finally {
      database.close();
    }

    const raw = new Database(join(configDir, DATABASE_FILENAME));
    expect(
      raw.query("SELECT COUNT(*) AS count FROM trajectory_records WHERE session_id = 'legacy'").get(),
    ).toEqual({ count: 2 });
    raw.close();
    expect(readFileSync(path)).toEqual(snapshot);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
