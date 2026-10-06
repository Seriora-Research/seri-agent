import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, type DaemonEvent, isLoopDaemonEvent } from "@seri/daemon-client";
import { MockLanguageModelV4 } from "ai/test";
import { type ExecuteTurn, startDaemon } from "../../src/daemon/server";
import { DaemonSessionManager } from "../../src/daemon/sessionManager";
import { DATABASE_FILENAME, SessionDatabase } from "../../src/session/database";
import { fakeRunLoop } from "../cli/fakeRunLoop";
import { streamResult, textOnlyChunks } from "../loop/fixtures";

let dirs: string[] = [];
let stop: (() => Promise<void>) | undefined;

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-daemon-turns-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (stop !== undefined) {
    await stop();
    stop = undefined;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collect(events: AsyncIterable<DaemonEvent>): Promise<DaemonEvent[]> {
  const collected: DaemonEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("daemon turns", () => {
  test("a turn stream has monotonic sequence numbers and never includes messages-updated", async () => {
    const executeTurn: ExecuteTurn = async (input) => {
      input.emitLoop({ type: "messages-updated", messages: [] });
      input.emitLoop({ type: "text-delta", text: "ready" });
      input.emitLoop({ type: "done", reason: "no-tool-call" });
      return { exitCode: 0 };
    };
    const daemon = await startDaemon({ configDir: makeDir(), executeTurn });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const events = await collect(client.startTurn({ task: "say ready" }));
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.some((event) => JSON.stringify(event).includes("messages-updated"))).toBe(false);
    expect(events.at(-1)?.event).toEqual({ type: "turn-complete", exitCode: 0 });
  });

  test("after a finished turn, events after the last live delta seq still return compact rows", async () => {
    const executeTurn: ExecuteTurn = async (input) => {
      input.emitLoop({ type: "text-delta", text: "one" });
      input.emitLoop({ type: "text-delta", text: "two" });
      input.emitLoop({ type: "done", reason: "no-tool-call" });
      return { exitCode: 0 };
    };
    const daemon = await startDaemon({ configDir: makeDir(), executeTurn });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const live = await collect(client.startTurn({ task: "split" }));
    let lastDelta: DaemonEvent | undefined;
    for (const event of live) {
      if (isLoopDaemonEvent(event.event) && event.event.value.type === "text-delta")
        lastDelta = event;
    }
    expect(lastDelta?.seq).toBe(2);
    expect(live.at(-1)?.event).toEqual({ type: "turn-complete", exitCode: 0 });
    const rest = await collect(client.events(live[0]!.turnId, lastDelta!.seq));
    expect(rest.some((event) => JSON.stringify(event).includes("text-delta"))).toBe(false);
    expect(
      rest.some((event) => isLoopDaemonEvent(event.event) && event.event.value.type === "done"),
    ).toBe(true);
    expect(rest.at(-1)?.event).toEqual({ type: "turn-complete", exitCode: 0 });
  });

  test("reconnecting after a missed text-delta still replays it", async () => {
    const sawOne = Promise.withResolvers<void>();
    const twoReady = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const executeTurn: ExecuteTurn = async (input) => {
      input.emitLoop({ type: "text-delta", text: "one" });
      await sawOne.promise;
      input.emitLoop({ type: "text-delta", text: "two" });
      twoReady.resolve();
      await released.promise;
      input.emitLoop({ type: "done", reason: "no-tool-call" });
      return { exitCode: 0 };
    };
    const daemon = await startDaemon({ configDir: makeDir(), executeTurn });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const liveIter = client.startTurn({ task: "split" })[Symbol.asyncIterator]();
    const first = (await liveIter.next()).value as DaemonEvent;
    expect(first.event).toEqual({ type: "loop", value: { type: "text-delta", text: "one" } });
    await liveIter.return?.();
    sawOne.resolve();
    await twoReady.promise;
    const restIter = client.events(first.turnId, 1)[Symbol.asyncIterator]();
    try {
      const second = await Promise.race([
        restIter.next(),
        delay(2000).then(() => {
          throw new Error("timed out waiting for replayed text-delta two");
        }),
      ]);
      expect(second.done).toBe(false);
      expect(second.value?.event).toEqual({
        type: "loop",
        value: { type: "text-delta", text: "two" },
      });
      released.resolve();
      const rest = [second.value!, ...(await collect({ [Symbol.asyncIterator]: () => restIter }))];
      expect(rest.some((event) => JSON.stringify(event).includes('"text":"one"'))).toBe(false);
      expect(rest.some((event) => JSON.stringify(event).includes('"text":"two"'))).toBe(true);
    } finally {
      released.resolve();
    }
  });

  test("daemon_events omit text-delta and reasoning-delta after the turn finishes", async () => {
    const configDir = makeDir();
    const database = new SessionDatabase(configDir);
    const manager = new DaemonSessionManager(
      database,
      async (input) => {
        for (let i = 0; i < 50; i++) input.emitLoop({ type: "text-delta", text: "x" });
        input.emitLoop({ type: "reasoning-delta", text: "think" });
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
      { idleMs: 0 },
    );
    try {
      const started = await manager.startTurn({ task: "stream" });
      const live: DaemonEvent[] = [];
      await new Promise<void>((resolve) => {
        started.subscribe((event) => {
          live.push(event);
          if (event.event.type === "turn-complete") resolve();
        });
      });
      await manager.waitForIdle();
      const liveLoop = live.flatMap((event) =>
        isLoopDaemonEvent(event.event) ? [event.event.value.type] : [],
      );
      expect(liveLoop.filter((type) => type === "text-delta")).toHaveLength(50);
      expect(liveLoop).toContain("reasoning-delta");
      const persisted = database.listDaemonEventsAfter(started.turnId, 0) as DaemonEvent[];
      const persistedLoop = persisted.flatMap((event) =>
        isLoopDaemonEvent(event.event) ? [event.event.value.type] : [],
      );
      expect(persistedLoop).not.toContain("text-delta");
      expect(persistedLoop).not.toContain("reasoning-delta");
      expect(persistedLoop).toEqual(["done"]);
      expect(persisted.map((event) => event.seq)).toEqual([52, 53]);
      expect(persisted).toHaveLength(2);
      expect(persisted.at(-1)?.event).toEqual({ type: "turn-complete", exitCode: 0 });
      expect(manager.getTurn(started.turnId)).toBeUndefined();
      const afterLastDelta = database.listDaemonEventsAfter(started.turnId, 51) as DaemonEvent[];
      expect(afterLastDelta.map((event) => event.seq)).toEqual([52, 53]);
    } finally {
      manager.cancelAll();
      await manager.waitForIdle();
      database.close();
    }
  });

  test("disconnecting resolves a pending approval as no but does not cancel the turn", async () => {
    let answer: string | undefined;
    let aborted = false;
    let finished = false;
    const executeTurn: ExecuteTurn = async (input) => {
      answer = await input.requestApproval("req-1", "write_file", { path: "a.txt" });
      aborted = input.signal.aborted;
      input.emitLoop({ type: "done", reason: "no-tool-call" });
      finished = true;
      return { exitCode: 0 };
    };
    const daemon = await startDaemon({ configDir: makeDir(), executeTurn });
    stop = daemon.stop;
    const response = await fetch(`${daemon.endpoint}/v1/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "write" }),
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const deadline = Date.now() + 2000;
    while (!finished && Date.now() < deadline) await delay(10);
    expect(answer).toBe("no");
    expect(aborted).toBe(false);
    expect(finished).toBe(true);
  });

  test("startTurn with permissionPrompts none never emits approval-request when executeTurn would have requested one", async () => {
    const configDir = makeDir();
    const originalKey = process.env.GROQ_API_KEY;
    const originalDisable = process.env.SERI_DISABLE_MODELS_FETCH;
    process.env.GROQ_API_KEY = "fake-test-key";
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
    const { fake, capture } = fakeRunLoop([{ type: "done", reason: "no-tool-call" }]);
    async function* wouldPrompt(opts: Parameters<typeof fake>[0]) {
      const gen = fake(opts);
      if (opts.approvalPrompt !== undefined) {
        await opts.approvalPrompt("write_file", { path: "a.txt" }, opts.signal);
      }
      yield* gen;
    }
    try {
      const daemon = await startDaemon({
        configDir,
        idleMs: 0,
        deps: {
          runLoop: wouldPrompt,
          getGroqModel: () =>
            new MockLanguageModelV4({
              doStream: async () => streamResult(textOnlyChunks("ready")),
            }),
          loadAgentsFile: () => "",
        },
      });
      stop = daemon.stop;
      const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
      const live = client.startTurn({ task: "write live" });
      const liveIter = live[Symbol.asyncIterator]();
      let liveApproval: { turnId: string; requestId: string } | undefined;
      while (liveApproval === undefined) {
        const next = await liveIter.next();
        expect(next.done).toBe(false);
        const event = next.value!;
        if (event.event.type === "approval-request" && typeof event.event.requestId === "string") {
          liveApproval = { turnId: event.turnId, requestId: event.event.requestId };
        }
      }
      await client.approve(liveApproval.turnId, liveApproval.requestId, "once");
      await collect({ [Symbol.asyncIterator]: () => liveIter });
      const events = await collect(
        client.startTurn({ task: "write none", permissionPrompts: "none" }),
      );
      expect(events.some((event) => event.event.type === "approval-request")).toBe(false);
      expect(capture()?.approvalPrompt).toBeUndefined();
      expect(events.at(-1)?.event).toEqual({ type: "turn-complete", exitCode: 0 });
    } finally {
      if (originalKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalKey;
      if (originalDisable === undefined) delete process.env.SERI_DISABLE_MODELS_FETCH;
      else process.env.SERI_DISABLE_MODELS_FETCH = originalDisable;
    }
  });

  test("matching approval resumes a turn; a mismatched pair returns 404", async () => {
    const executeTurn: ExecuteTurn = async (input) => {
      const granted = await input.requestApproval("req-ok", "write_file", { path: "a.txt" });
      input.emitLoop({ type: "tool-result", name: "write_file", result: granted });
      input.emitLoop({ type: "done", reason: "no-tool-call" });
      return { exitCode: 0 };
    };
    const daemon = await startDaemon({ configDir: makeDir(), executeTurn });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const stream = client.startTurn({ task: "write" });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    const event = first.value!;
    expect(event.event.type).toBe("approval-request");
    const mismatched = await fetch(
      `${daemon.endpoint}/v1/turns/${event.turnId}/approvals/not-this`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ answer: "once" }),
      },
    );
    expect(mismatched.status).toBe(404);
    if (event.event.type === "approval-request") {
      await client.approve(event.turnId, event.event.requestId, "once");
    }
    const rest: DaemonEvent[] = [];
    for await (const next of { [Symbol.asyncIterator]: () => iterator }) rest.push(next);
    expect(
      rest.some((item) => isLoopDaemonEvent(item.event) && item.event.value.type === "tool-result"),
    ).toBe(true);
  });

  test("cancelling session A leaves session B running", async () => {
    const releasedB = Promise.withResolvers<void>();
    const sawB = Promise.withResolvers<void>();
    let bAborted = false;
    const executeTurn: ExecuteTurn = async (input) => {
      if (input.task === "A") {
        input.emitLoop({ type: "text-delta", text: "a" });
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { exitCode: 1 };
      }
      sawB.resolve();
      await releasedB.promise;
      bAborted = input.signal.aborted;
      input.emitLoop({ type: "done", reason: "no-tool-call" });
      return { exitCode: 0 };
    };
    const daemon = await startDaemon({ configDir: makeDir(), executeTurn });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const iterA = client.startTurn({ task: "A" })[Symbol.asyncIterator]();
    const firstA = (await iterA.next()).value as DaemonEvent;
    const eventsBPromise = collect(client.startTurn({ task: "B" }));
    await sawB.promise;
    await client.cancel(firstA.turnId);
    releasedB.resolve();
    const eventsB = await eventsBPromise;
    expect(bAborted).toBe(false);
    expect(eventsB.at(-1)?.event).toEqual({ type: "turn-complete", exitCode: 0 });
  });

  test("two sessions overlap; two turns on one session do not", async () => {
    let current = 0;
    let maxConcurrent = 0;
    const executeTurn: ExecuteTurn = async (input) => {
      current += 1;
      maxConcurrent = Math.max(maxConcurrent, current);
      await delay(60);
      current -= 1;
      input.emitLoop({ type: "text-delta", text: input.task });
      input.emitLoop({ type: "done", reason: "no-tool-call" });
      return { exitCode: 0 };
    };
    const daemon = await startDaemon({ configDir: makeDir(), executeTurn });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });

    maxConcurrent = 0;
    current = 0;
    await Promise.all([
      collect(client.startTurn({ task: "s1" })),
      collect(client.startTurn({ task: "s2" })),
    ]);
    expect(maxConcurrent).toBe(2);

    const first = await collect(client.startTurn({ task: "seed" }));
    const sessionId = first[0]!.sessionId;
    maxConcurrent = 0;
    current = 0;
    await Promise.all([
      collect(client.startTurn({ task: "t1", sessionId })),
      collect(client.startTurn({ task: "t2", sessionId })),
    ]);
    expect(maxConcurrent).toBe(1);
  });

  test("finished turn handles are dropped once events are persisted", async () => {
    const configDir = makeDir();
    const database = new SessionDatabase(configDir);
    const manager = new DaemonSessionManager(
      database,
      async (input) => {
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
      { idleMs: 0 },
    );
    try {
      const started = await manager.startTurn({ task: "done" });
      await new Promise<void>((resolve) => {
        started.subscribe((event) => {
          if (event.event.type === "turn-complete") resolve();
        });
      });
      await manager.waitForIdle();
      expect(manager.getTurn(started.turnId)).toBeUndefined();
      expect(database.hasTurn(started.turnId)).toBe(true);
    } finally {
      manager.cancelAll();
      await manager.waitForIdle();
      database.close();
    }
  });

  test("a previous process's running turn is interrupted on daemon start and the session keeps its permission mode", async () => {
    const configDir = makeDir();
    const setup = new SessionDatabase(configDir);
    setup.saveSession({
      id: "sess-auto",
      cwd: configDir,
      systemPrompt: "",
      permissionMode: "auto",
      messages: [{ role: "user", content: "hello" }],
    });
    setup.insertTurn("turn-crash", "sess-auto", "2026-10-06T13:00:00.000Z");
    setup.appendDaemonEvent("turn-crash", 1, {
      v: 1,
      sessionId: "sess-auto",
      turnId: "turn-crash",
      seq: 1,
      event: {
        type: "loop",
        value: { type: "tool-call", name: "bash", args: { command: "sleep 60" } },
      },
    });
    setup.insertTurn("turn-done", "sess-auto", "2026-10-06T12:00:00.000Z");
    setup.appendDaemonEvent("turn-done", 1, {
      v: 1,
      sessionId: "sess-auto",
      turnId: "turn-done",
      seq: 1,
      event: { type: "turn-complete", exitCode: 0 },
    });
    setup.finishTurn("turn-done", "2026-10-06T12:00:01.000Z");
    setup.close();

    const modes: string[] = [];
    const executeTurn: ExecuteTurn = async (input) => {
      modes.push(input.permissionMode);
      input.emitLoop({ type: "done", reason: "no-tool-call" });
      return { exitCode: 0 };
    };
    const daemon = await startDaemon({ configDir, executeTurn, idleMs: 0 });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const crashed = await collect(client.events("turn-crash"));
    expect(crashed.at(-1)?.event).toEqual({ type: "turn-interrupted" });
    expect(crashed.filter((event) => event.event.type === "turn-interrupted")).toHaveLength(1);

    const finished = await collect(client.events("turn-done"));
    expect(finished.at(-1)?.event).toEqual({ type: "turn-complete", exitCode: 0 });

    const probe = new SessionDatabase(configDir);
    try {
      expect(probe.loadSession("sess-auto")?.permissionMode).toBe("auto");
    } finally {
      probe.close();
    }

    const raw = new Database(join(configDir, DATABASE_FILENAME));
    try {
      const crashRow = raw
        .query("SELECT status, finished_at FROM turns WHERE id = ?")
        .get("turn-crash") as { status: string; finished_at: string | null };
      expect(crashRow.status).toBe("interrupted");
      expect(crashRow.finished_at).not.toBeNull();
      const doneRow = raw.query("SELECT status FROM turns WHERE id = ?").get("turn-done") as {
        status: string;
      };
      expect(doneRow.status).toBe("complete");
    } finally {
      raw.close();
    }

    await collect(client.startTurn({ task: "next", sessionId: "sess-auto" }));
    expect(modes).toEqual(["auto"]);

    await daemon.stop();
    stop = undefined;
    const again = await startDaemon({ configDir, executeTurn, idleMs: 0 });
    stop = again.stop;
    const client2 = new DaemonClient({ endpoint: again.endpoint, token: again.token });
    const replayed = await collect(client2.events("turn-crash"));
    expect(replayed.filter((event) => event.event.type === "turn-interrupted")).toHaveLength(1);
    expect(replayed.at(-1)?.event).toEqual({ type: "turn-interrupted" });
  });

  test("restart interrupt seq is after live deltas that were never persisted", async () => {
    const configDir = makeDir();
    const setup = new SessionDatabase(configDir);
    setup.saveSession({
      id: "sess-live",
      cwd: configDir,
      systemPrompt: "",
      permissionMode: "approve-each",
      messages: [],
    });
    setup.insertTurn("turn-live", "sess-live", "2026-10-06T13:00:00.000Z");
    setup.appendDaemonEvent("turn-live", 1, {
      v: 1,
      sessionId: "sess-live",
      turnId: "turn-live",
      seq: 1,
      event: {
        type: "loop",
        value: { type: "tool-call", name: "bash", args: { command: "sleep 60" } },
      },
    });
    setup.setTurnLastSeq("turn-live", 4);
    setup.close();

    const daemon = await startDaemon({
      configDir,
      executeTurn: async () => ({ exitCode: 0 }),
      idleMs: 0,
    });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const fromLiveWatermark = await collect(client.events("turn-live", 4));
    expect(fromLiveWatermark).toHaveLength(1);
    expect(fromLiveWatermark[0]?.seq).toBe(5);
    expect(fromLiveWatermark[0]?.event).toEqual({ type: "turn-interrupted" });
  });

  test("a running turn that already persisted turn-complete is finished complete, not interrupted", async () => {
    const configDir = makeDir();
    const setup = new SessionDatabase(configDir);
    setup.saveSession({
      id: "sess-done",
      cwd: configDir,
      systemPrompt: "",
      permissionMode: "approve-each",
      messages: [],
    });
    setup.insertTurn("turn-half", "sess-done", "2026-10-06T13:00:00.000Z");
    setup.appendDaemonEvent("turn-half", 1, {
      v: 1,
      sessionId: "sess-done",
      turnId: "turn-half",
      seq: 1,
      event: { type: "turn-complete", exitCode: 0 },
    });
    setup.close();

    const daemon = await startDaemon({
      configDir,
      executeTurn: async () => ({ exitCode: 0 }),
      idleMs: 0,
    });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const events = await collect(client.events("turn-half"));
    expect(events.map((event) => event.event)).toEqual([{ type: "turn-complete", exitCode: 0 }]);

    const raw = new Database(join(configDir, DATABASE_FILENAME));
    try {
      const row = raw.query("SELECT status FROM turns WHERE id = ?").get("turn-half") as {
        status: string;
      };
      expect(row.status).toBe("complete");
    } finally {
      raw.close();
    }
  });

  test("live text-deltas advance last_seq even though they are not stored as daemon_events", async () => {
    const configDir = makeDir();
    const database = new SessionDatabase(configDir);
    const released = Promise.withResolvers<void>();
    const emitted = Promise.withResolvers<void>();
    const manager = new DaemonSessionManager(
      database,
      async (input) => {
        input.emitLoop({ type: "text-delta", text: "a" });
        input.emitLoop({ type: "text-delta", text: "b" });
        emitted.resolve();
        await released.promise;
        return { exitCode: 0 };
      },
      { idleMs: 0 },
    );
    try {
      const started = await manager.startTurn({ task: "stream" });
      started.subscribe(() => {});
      await emitted.promise;
      expect(database.turnLastSeq(started.turnId)).toBe(2);
      expect(database.maxDaemonEventSeq(started.turnId)).toBe(0);
    } finally {
      released.resolve();
      manager.cancelAll();
      await manager.waitForIdle();
      database.close();
    }
  });
});
