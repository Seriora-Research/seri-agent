import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@seri/daemon-client";
import {
  assertScheduledToolset,
  parseScheduleRequest,
  type ScheduledRunInput,
  Scheduler,
} from "../../src/daemon/scheduler";
import { startDaemon } from "../../src/daemon/server";
import { createScheduledToolDefinitions, createToolDefinitions } from "../../src/provider/tools";
import { SessionDatabase } from "../../src/session/database";
import { withTodo } from "../../src/todo/tool";

let dirs: string[] = [];
let stop: (() => Promise<void>) | undefined;
let openDatabases: SessionDatabase[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-sched-"));
  dirs.push(dir);
  return dir;
}

function openDatabase(configDir: string): SessionDatabase {
  const database = new SessionDatabase(configDir);
  openDatabases.push(database);
  return database;
}

afterEach(async () => {
  if (stop !== undefined) {
    await stop();
    stop = undefined;
  }
  for (const database of openDatabases) {
    try {
      database.close();
    } catch {}
  }
  openDatabases = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("scheduled toolset", () => {
  test("exact read-only tools, empty grants, no dispatch or memory", () => {
    const dir = makeDir();
    const tools = createScheduledToolDefinitions(dir);
    expect(Object.keys(tools).sort()).toEqual(["glob", "grep", "read_file"]);
    assertScheduledToolset(tools);
  });

  test("assertScheduledToolset rejects the normal write-capable toolset", () => {
    const dir = makeDir();
    expect(() => assertScheduledToolset(createToolDefinitions(dir))).toThrow(/write_file/);
  });

  test("assertScheduledToolset rejects ask_user", () => {
    const dir = makeDir();
    const tools = { ...createScheduledToolDefinitions(dir), ask_user: {} };
    expect(() => assertScheduledToolset(tools)).toThrow(/ask_user/);
  });

  test("assertScheduledToolset rejects a scheduled set with todo injected", () => {
    const dir = makeDir();
    expect(() => assertScheduledToolset(withTodo(createScheduledToolDefinitions(dir)))).toThrow(
      /todo/,
    );
  });

  test("createRunScheduled asks buildSystemPrompt to omit parent-only tools", async () => {
    const src = await Bun.file(new URL("../../src/daemon/scheduled.ts", import.meta.url)).text();
    const start = src.indexOf("systemPrompt: buildSystemPrompt");
    expect(start).toBeGreaterThanOrEqual(0);
    const call = src.slice(start, src.indexOf("model: route.model", start));
    expect(call).toContain("composeSubagents: false");
  });

  test("createRunScheduled loads path denials from permissionsDir", async () => {
    const src = await Bun.file(new URL("../../src/daemon/scheduled.ts", import.meta.url)).text();
    expect(src).toMatch(/loadDenials\(\s*opts\.permissionsDir/);
    expect(src).toMatch(/permissionsDir:\s*opts\.permissionsDir/);
    expect(src).not.toMatch(/loadDenials\(\s*opts\.configDir/);
  });
});

describe("schedule validation", () => {
  test("rejects origin scheduled, missing allowModelReads, and offset-less ISO", () => {
    expect(() =>
      parseScheduleRequest({
        origin: "scheduled",
        task: "x",
        cwd: "/tmp",
        timing: { kind: "interval", everySeconds: 60 },
        allowModelReads: true,
      }),
    ).toThrow(/origin scheduled/);
    expect(() =>
      parseScheduleRequest({
        task: "x",
        cwd: "/tmp",
        timing: { kind: "interval", everySeconds: 60 },
      }),
    ).toThrow(/allowModelReads/);
    expect(() =>
      parseScheduleRequest({
        task: "x",
        cwd: "/tmp",
        timing: { kind: "once", at: "2026-01-01T00:00:00" },
        allowModelReads: true,
      }),
    ).toThrow(/explicit offset/);
  });
});

describe("Scheduler", () => {
  test("every firing gets a fresh session whose only user message is the scheduled task", async () => {
    const configDir = makeDir();
    const database = openDatabase(configDir);
    const seen: ScheduledRunInput[] = [];
    let now = 1_000_000;
    const scheduler = new Scheduler(
      database,
      async (input) => {
        seen.push(input);
        return { response: "ok" };
      },
      () => now,
    );
    scheduler.create({
      task: "report ready",
      cwd: configDir,
      timing: { kind: "once", at: "1970-01-01T00:16:40.000Z" },
      allowModelReads: true,
    });
    await scheduler.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.session.messages).toEqual([{ role: "user", content: "report ready" }]);
    expect(seen[0]!.policy).toEqual({
      origin: "scheduled",
      permissionMode: "read-only",
      allowedTools: [],
    });
    expect(seen[0]!.policy).not.toHaveProperty("approvalPrompt");
    const secondTask = "report again";
    now = 2_000_000;
    scheduler.create({
      task: secondTask,
      cwd: configDir,
      timing: { kind: "once", at: "1970-01-01T00:33:20.000Z" },
      allowModelReads: true,
    });
    await scheduler.tick();
    expect(seen).toHaveLength(2);
    expect(seen[1]!.session.id).not.toBe(seen[0]!.session.id);
    expect(seen[1]!.session.messages).toEqual([{ role: "user", content: secondTask }]);
    const runs = database.listScheduleRuns(seen[0]!.scheduleId);
    expect(runs[0]?.response).toBe("ok");
    expect(runs[0]?.sessionId).toBe(seen[0]!.session.id);
  });

  test("two ticks cannot claim one firing twice", async () => {
    const configDir = makeDir();
    const database = openDatabase(configDir);
    const now = 5_000_000;
    let started = 0;
    const hold = Promise.withResolvers<void>();
    const schedulerA = new Scheduler(
      database,
      async () => {
        started += 1;
        await hold.promise;
        return { response: "a" };
      },
      () => now,
    );
    const schedulerB = new Scheduler(
      database,
      async () => {
        started += 1;
        await hold.promise;
        return { response: "b" };
      },
      () => now,
    );
    const created = schedulerA.create({
      task: "once",
      cwd: configDir,
      timing: { kind: "once", at: "1970-01-01T01:23:20.000Z" },
      allowModelReads: true,
    });
    const ticks = Promise.all([schedulerA.tick(), schedulerB.tick()]);
    await Bun.sleep(20);
    expect(started).toBe(1);
    hold.resolve();
    await ticks;
    expect(database.listScheduleRuns(created.id)).toHaveLength(1);
  });

  test("startup advances missed intervals without catch-up", async () => {
    const configDir = makeDir();
    const database = openDatabase(configDir);
    let now = 10_000;
    const fired: string[] = [];
    const scheduler = new Scheduler(
      database,
      async (input) => {
        fired.push(input.session.id);
        return { response: "ran" };
      },
      () => now,
    );
    const created = scheduler.create({
      task: "interval",
      cwd: configDir,
      timing: { kind: "interval", everySeconds: 60 },
      allowModelReads: true,
    });
    now = 10_000 + 60_000 * 5;
    scheduler.start();
    scheduler.stop();
    await scheduler.tick();
    expect(fired).toEqual([]);
    const skipped = database.getSchedule(created.id);
    expect(skipped?.nextRunAtMs).toBeGreaterThan(now);
  });

  test("startup clears a crashed running claim so the next due tick can fire", async () => {
    const configDir = makeDir();
    const database = openDatabase(configDir);
    let now = 20_000;
    const fired: string[] = [];
    const scheduler = new Scheduler(
      database,
      async (input) => {
        fired.push(input.scheduleId);
        return { response: "ran" };
      },
      () => now,
    );
    const created = scheduler.create({
      task: "interval",
      cwd: configDir,
      timing: { kind: "interval", everySeconds: 60 },
      allowModelReads: true,
    });
    now = 80_000;
    const claimed = database.claimSchedule(created.id, now);
    expect(claimed?.running).toBe(true);
    expect(claimed?.nextRunAtMs).toBe(now);
    scheduler.start();
    scheduler.stop();
    const afterStart = database.getSchedule(created.id);
    expect(afterStart?.running).toBe(false);
    expect(afterStart?.nextRunAtMs).toBe(now);
    await scheduler.tick();
    expect(fired).toEqual([created.id]);
    expect(database.listScheduleRuns(created.id)).toHaveLength(1);
  });

  test("session mint failure leaves the firing pending with no schedule_runs row", async () => {
    const configDir = makeDir();
    const database = openDatabase(configDir);
    const now = 30_000;
    let runScheduledCalls = 0;
    const scheduler = new Scheduler(
      database,
      async () => {
        runScheduledCalls += 1;
        return { response: "should not run" };
      },
      () => now,
    );
    const created = scheduler.create({
      task: "once",
      cwd: configDir,
      timing: { kind: "once", at: "1970-01-01T00:00:30.000Z" },
      allowModelReads: true,
    });
    const dueAt = database.getSchedule(created.id)!.nextRunAtMs;
    database.saveSession = () => {
      throw new Error("cannot persist session");
    };
    await scheduler.tick();
    const after = database.getSchedule(created.id);
    expect(runScheduledCalls).toBe(0);
    expect(after?.enabled).toBe(true);
    expect(after?.running).toBe(false);
    expect(after?.nextRunAtMs).toBe(dueAt);
    expect(database.listScheduleRuns(created.id)).toHaveLength(0);
  });

  test("interval session mint failure does not advance nextRunAt", async () => {
    const configDir = makeDir();
    const database = openDatabase(configDir);
    let now = 35_000;
    const scheduler = new Scheduler(
      database,
      async () => ({ response: "should not run" }),
      () => now,
    );
    const created = scheduler.create({
      task: "interval",
      cwd: configDir,
      timing: { kind: "interval", everySeconds: 60 },
      allowModelReads: true,
    });
    now = database.getSchedule(created.id)!.nextRunAtMs!;
    const dueAt = now;
    database.saveSession = () => {
      throw new Error("cannot persist session");
    };
    await scheduler.tick();
    const after = database.getSchedule(created.id);
    expect(after?.enabled).toBe(true);
    expect(after?.nextRunAtMs).toBe(dueAt);
    expect(database.listScheduleRuns(created.id)).toHaveLength(0);
  });

  test("a mint failure on one due schedule does not skip the next due schedule", async () => {
    const configDir = makeDir();
    const database = openDatabase(configDir);
    const now = 45_000;
    const seen: string[] = [];
    const scheduler = new Scheduler(
      database,
      async (input) => {
        seen.push(input.scheduleId);
        return { response: "ran" };
      },
      () => now,
    );
    const first = scheduler.create({
      task: "first",
      cwd: configDir,
      timing: { kind: "once", at: "1970-01-01T00:00:45.000Z" },
      allowModelReads: true,
    });
    const second = scheduler.create({
      task: "second",
      cwd: configDir,
      timing: { kind: "once", at: "1970-01-01T00:00:45.000Z" },
      allowModelReads: true,
    });
    const due = database.listDueSchedules(now);
    expect(due.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    const failId = due[0]!.id;
    const okId = due[1]!.id;
    let remainingFails = 1;
    const originalSave = database.saveSession.bind(database);
    database.saveSession = (state) => {
      if (remainingFails > 0) {
        remainingFails -= 1;
        throw new Error("cannot persist session");
      }
      originalSave(state);
    };
    await scheduler.tick();
    expect(seen).toEqual([okId]);
    expect(database.getSchedule(failId)?.enabled).toBe(true);
    expect(database.listScheduleRuns(failId)).toHaveLength(0);
    expect(database.listScheduleRuns(okId)).toHaveLength(1);
    expect(database.getSchedule(okId)?.enabled).toBe(false);
  });

  test("an interval fire that advances nextRunAt always has a schedule_runs session for that fire", async () => {
    const configDir = makeDir();
    const database = openDatabase(configDir);
    let now = 40_000;
    const scheduler = new Scheduler(
      database,
      async () => ({ response: "ran" }),
      () => now,
    );
    const created = scheduler.create({
      task: "interval",
      cwd: configDir,
      timing: { kind: "interval", everySeconds: 60 },
      allowModelReads: true,
    });
    const before = database.getSchedule(created.id)!;
    now = before.nextRunAtMs!;
    await scheduler.tick();
    const after = database.getSchedule(created.id)!;
    expect(after.nextRunAtMs).toBeGreaterThan(now);
    const runs = database.listScheduleRuns(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("complete");
    expect(database.loadSession(runs[0]!.sessionId)?.id).toBe(runs[0]!.sessionId);
  });

  test("runScheduled failure records an error run then consumes the firing", async () => {
    const configDir = makeDir();
    const database = openDatabase(configDir);
    const now = 50_000;
    const scheduler = new Scheduler(
      database,
      async () => {
        throw new Error("model down");
      },
      () => now,
    );
    const created = scheduler.create({
      task: "once",
      cwd: configDir,
      timing: { kind: "once", at: "1970-01-01T00:00:50.000Z" },
      allowModelReads: true,
    });
    await scheduler.tick();
    const after = database.getSchedule(created.id);
    expect(after?.enabled).toBe(false);
    expect(after?.nextRunAtMs).toBeNull();
    const runs = database.listScheduleRuns(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("error");
    expect(runs[0]?.error).toBe("model down");
    expect(database.loadSession(runs[0]!.sessionId)?.id).toBe(runs[0]!.sessionId);
  });

  test("a tick drops stale scheduled sessions and keeps the schedule row", async () => {
    const configDir = makeDir();
    const database = openDatabase(configDir);
    const now = Date.parse("2026-09-11T00:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const scheduler = new Scheduler(
      database,
      async () => ({ response: "ok" }),
      () => now,
      60_000,
      30,
    );
    const created = scheduler.create({
      task: "report ready",
      cwd: configDir,
      timing: { kind: "once", at: "2026-09-11T00:00:00.000Z" },
      allowModelReads: true,
    });
    await scheduler.tick();
    const run = database.listScheduleRuns(created.id)[0];
    expect(run?.sessionId).toBeDefined();
    const sessionId = run!.sessionId;
    const raw = new Database(join(configDir, "seri.db"));
    raw
      .query("UPDATE sessions SET updated_at_ms = ? WHERE id = ?")
      .run(now - 31 * dayMs, sessionId);
    raw.close();
    await scheduler.tick();
    expect(database.loadSession(sessionId)).toBeUndefined();
    expect(database.listScheduleRuns(created.id)).toEqual([]);
    expect(database.getSchedule(created.id)?.id).toBe(created.id);
  });
});

describe("daemon schedule routes", () => {
  test("create, list, disable, and persisted runs", async () => {
    const configDir = makeDir();
    const seen: ScheduledRunInput[] = [];
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const daemon = await startDaemon({
      configDir,
      executeTurn: async (input) => {
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
      now: () => now,
      tickMs: 60_000,
      idleMs: 0,
      runScheduled: async (input) => {
        seen.push(input);
        return { response: "hello" };
      },
    });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const created = (await client.createSchedule({
      task: "hello",
      cwd: configDir,
      timing: { kind: "once", at: "2026-01-01T00:00:00.000Z" },
      allowModelReads: true,
    })) as { id: string };
    const listed = (await client.listSchedules()) as { schedules: { id: string }[] };
    expect(listed.schedules.some((row) => row.id === created.id)).toBe(true);
    await daemon.scheduler.tick();
    const runs = (await client.scheduleRuns(created.id)) as { runs: { response: string }[] };
    expect(runs.runs[0]?.response).toBe("hello");
    expect(seen[0]?.session.messages).toEqual([{ role: "user", content: "hello" }]);
    await client.disableSchedule(created.id);
  });
});
