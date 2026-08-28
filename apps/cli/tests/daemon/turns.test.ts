import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, type DaemonEvent, isLoopDaemonEvent } from "@seri/daemon-client";
import { type ExecuteTurn, startDaemon } from "../../src/daemon/server";
import { DaemonSessionManager } from "../../src/daemon/sessionManager";
import { SessionDatabase } from "../../src/session/database";

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

  test("reconnecting with after replays only later persisted events", async () => {
    const executeTurn: ExecuteTurn = async (input) => {
      input.emitLoop({ type: "text-delta", text: "one" });
      await delay(80);
      input.emitLoop({ type: "text-delta", text: "two" });
      input.emitLoop({ type: "done", reason: "no-tool-call" });
      return { exitCode: 0 };
    };
    const daemon = await startDaemon({ configDir: makeDir(), executeTurn });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const live = client.startTurn({ task: "split" });
    const first: DaemonEvent[] = [];
    for await (const event of live) {
      first.push(event);
      if (event.seq === 1) break;
    }
    expect(first[0]?.event).toEqual({ type: "loop", value: { type: "text-delta", text: "one" } });
    const rest = await collect(client.events(first[0]!.turnId, 1));
    expect(rest.some((event) => JSON.stringify(event).includes('"text":"one"'))).toBe(false);
    expect(rest.some((event) => JSON.stringify(event).includes('"text":"two"'))).toBe(true);
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
});
