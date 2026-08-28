import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonEvent } from "@seri/daemon-client";
import type { ModelCatalog } from "@seri/model-catalog";
import { MockLanguageModelV4 } from "ai/test";
import { setConfigValue } from "../../src/config/config";
import { getPendingDir } from "../../src/config/paths";
import { flushIdleArchivist } from "../../src/daemon/idle";
import { startDaemon } from "../../src/daemon/server";
import { DaemonSessionManager } from "../../src/daemon/sessionManager";
import type { MemoryContext } from "../../src/memory/store";
import { makeMemoryWriteTool } from "../../src/memory/tool";
import { SessionDatabase } from "../../src/session/database";
import { streamResult, textOnlyChunks } from "../loop/fixtures";
import { fakeChildLoop } from "../subagents/fakeChildLoop";

let dirs: string[] = [];
let stop: (() => Promise<void>) | undefined;

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-idle-"));
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

const catalog: ModelCatalog = { fetchedAt: "", entries: [] };

function callTool(
  toolDef: ReturnType<typeof makeMemoryWriteTool>,
  args: Record<string, unknown>,
): Promise<unknown> {
  return toolDef.execute!(
    args as never,
    { toolCallId: "t1", messages: [] } as never,
  ) as Promise<unknown>;
}

describe("idle archivist flush", () => {
  test("flush finishes before eviction", async () => {
    const order: string[] = [];
    const configDir = makeDir();
    const daemon = await startDaemon({
      configDir,
      idleMs: 30,
      executeTurn: async (input) => {
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
      onIdleFlush: async (sessionId) => {
        order.push(`flush:${sessionId}`);
        await Bun.sleep(20);
        order.push("flushed");
      },
    });
    stop = daemon.stop;
    const response = await fetch(`${daemon.endpoint}/v1/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "hi" }),
    });
    await response.text();
    const deadline = Date.now() + 2000;
    while (order.length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(order[0]?.startsWith("flush:")).toBe(true);
    expect(order[1]).toBe("flushed");
  });

  test("forceStage stages a write even when approval is off", async () => {
    const configDir = makeDir();
    setConfigValue("SERI_MEMORY_APPROVAL", "false", configDir);
    const ctx: MemoryContext = { configDir, worktree: configDir };
    const tool = makeMemoryWriteTool(ctx, { forceStage: true });
    const result = (await callTool(tool, {
      scope: "user",
      action: "add",
      content: "remember the staging rule",
      reason: "idle flush",
      durable: true,
    })) as { staged: boolean };
    expect(result.staged).toBe(true);
    expect(readdirSync(getPendingDir(configDir)).length).toBeGreaterThan(0);
  });

  test("cursor advances once including a pass that wrote nothing", async () => {
    const configDir = makeDir();
    const database = new SessionDatabase(configDir);
    database.saveSession({
      id: "sess-idle",
      cwd: configDir,
      systemPrompt: "",
      permissionMode: "approve-each",
      messages: [{ role: "user", content: "hello there" }],
    });
    expect(database.getArchivistCursor("sess-idle")).toBe(0);
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("nothing to store")),
    });
    await flushIdleArchivist({
      database,
      sessionId: "sess-idle",
      ctx: { configDir, worktree: configDir },
      model,
      route: { model: "m", provider: "groq" },
      catalog,
      contextWindow: 100_000,
      signal: new AbortController().signal,
      onWarning: () => {},
      runLoop: fakeChildLoop(() => ({
        events: [{ type: "done", reason: "no-tool-call" }],
      })).fake,
    });
    expect(database.getArchivistCursor("sess-idle")).toBe(1);
    await flushIdleArchivist({
      database,
      sessionId: "sess-idle",
      ctx: { configDir, worktree: configDir },
      model,
      route: { model: "m", provider: "groq" },
      catalog,
      contextWindow: 100_000,
      signal: new AbortController().signal,
      onWarning: () => {},
      runLoop: fakeChildLoop(() => ({
        events: [{ type: "done", reason: "no-tool-call" }],
      })).fake,
    });
    expect(database.getArchivistCursor("sess-idle")).toBe(1);
    database.close();
  });

  test("a turn that starts during idle flush is not evicted off a new handle", async () => {
    const configDir = makeDir();
    const database = new SessionDatabase(configDir);
    database.saveSession({
      id: "sess-race",
      cwd: configDir,
      systemPrompt: "",
      permissionMode: "approve-each",
      messages: [],
    });
    const flushStarted = Promise.withResolvers<void>();
    let flushEndedWhileTurnTwoRunning = false;
    let turnTwoRunning = false;
    const manager = new DaemonSessionManager(
      database,
      async (input) => {
        if (input.task === "two") {
          turnTwoRunning = true;
          await Bun.sleep(80);
          turnTwoRunning = false;
        }
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
      {
        idleMs: 20,
        onIdleFlush: async () => {
          flushStarted.resolve();
          await Bun.sleep(50);
          if (turnTwoRunning) flushEndedWhileTurnTwoRunning = true;
        },
      },
    );

    async function completeTurn(task: string): Promise<void> {
      const started = await manager.startTurn({ task, sessionId: "sess-race" });
      await new Promise<void>((resolve) => {
        started.subscribe((event: DaemonEvent) => {
          if (event.event.type === "turn-complete") resolve();
        });
      });
    }

    try {
      await completeTurn("one");
      await flushStarted.promise;
      await completeTurn("two");
      expect(flushEndedWhileTurnTwoRunning).toBe(false);
      expect(manager.evictedSessionIds).not.toContain("sess-race");
    } finally {
      manager.cancelAll();
      await manager.waitForIdle();
      database.close();
    }
  });

  test("an idle flush throw does not permanently hang the next turn", async () => {
    const configDir = makeDir();
    const database = new SessionDatabase(configDir);
    database.saveSession({
      id: "sess-poison",
      cwd: configDir,
      systemPrompt: "",
      permissionMode: "approve-each",
      messages: [],
    });
    const manager = new DaemonSessionManager(
      database,
      async (input) => {
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
      {
        idleMs: 15,
        onIdleFlush: async () => {
          throw new Error("idle route failed");
        },
      },
    );

    async function completeTurn(task: string): Promise<void> {
      const started = await manager.startTurn({ task, sessionId: "sess-poison" });
      await new Promise<void>((resolve) => {
        started.subscribe((event: DaemonEvent) => {
          if (event.event.type === "turn-complete") resolve();
        });
      });
    }

    try {
      await completeTurn("one");
      await Bun.sleep(40);
      const second = completeTurn("two");
      const timedOut = await Promise.race([
        second.then(() => "ok"),
        Bun.sleep(1000).then(() => "timeout"),
      ]);
      expect(timedOut).toBe("ok");
    } finally {
      manager.cancelAll();
      await manager.waitForIdle();
      database.close();
    }
  });

  test("idle delay starts after the last queued turn, not after an earlier turn in the same session", async () => {
    const configDir = makeDir();
    const database = new SessionDatabase(configDir);
    database.saveSession({
      id: "sess-queue",
      cwd: configDir,
      systemPrompt: "",
      permissionMode: "approve-each",
      messages: [],
    });
    const holdFirst = Promise.withResolvers<void>();
    let secondEndedAt = 0;
    let flushedAt = 0;
    const manager = new DaemonSessionManager(
      database,
      async (input) => {
        if (input.task === "one") await holdFirst.promise;
        if (input.task === "two") await Bun.sleep(40);
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        if (input.task === "two") secondEndedAt = Date.now();
        return { exitCode: 0 };
      },
      {
        idleMs: 50,
        onIdleFlush: async () => {
          flushedAt = Date.now();
        },
      },
    );

    try {
      const first = await manager.startTurn({ task: "one", sessionId: "sess-queue" });
      const firstDone = new Promise<void>((resolve) => {
        first.subscribe((event: DaemonEvent) => {
          if (event.event.type === "turn-complete") resolve();
        });
      });
      const second = await manager.startTurn({ task: "two", sessionId: "sess-queue" });
      const secondDone = new Promise<void>((resolve) => {
        second.subscribe((event: DaemonEvent) => {
          if (event.event.type === "turn-complete") resolve();
        });
      });
      holdFirst.resolve();
      await firstDone;
      await secondDone;
      const deadline = Date.now() + 400;
      while (flushedAt === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(flushedAt).toBeGreaterThan(0);
      expect(flushedAt - secondEndedAt).toBeGreaterThanOrEqual(40);
    } finally {
      manager.cancelAll();
      await manager.waitForIdle();
      database.close();
    }
  });

  test("daemon stop aborts an in-flight idle flush", async () => {
    const flushStarted = Promise.withResolvers<void>();
    let aborted = false;
    const daemon = await startDaemon({
      configDir: makeDir(),
      idleMs: 20,
      executeTurn: async (input) => {
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
      onIdleFlush: async (_sessionId, signal) => {
        flushStarted.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            aborted = true;
            resolve();
            return;
          }
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
      },
    });
    stop = daemon.stop;
    const response = await fetch(`${daemon.endpoint}/v1/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "hi" }),
    });
    await response.text();
    await flushStarted.promise;
    const began = Date.now();
    await daemon.stop();
    stop = undefined;
    expect(aborted).toBe(true);
    expect(Date.now() - began).toBeLessThan(2000);
  });
});
