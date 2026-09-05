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
    } catch {
      // already closed
    }
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

  test("assertScheduledToolset rejects a scheduled set with todo injected", () => {
    const dir = makeDir();
    expect(() => assertScheduledToolset(withTodo(createScheduledToolDefinitions(dir)))).toThrow(
      /todo/,
    );
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
    const afterClaim = database.getSchedule(created.id);
    scheduler.start();
    scheduler.stop();
    now = afterClaim!.nextRunAtMs!;
    await scheduler.tick();
    expect(fired).toEqual([created.id]);
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
