import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog } from "@seri/model-catalog";
import { MockLanguageModelV4 } from "ai/test";
import { setConfigValue } from "../../src/config/config";
import { getPendingDir } from "../../src/config/paths";
import { flushIdleArchivist } from "../../src/daemon/idle";
import { startDaemon } from "../../src/daemon/server";
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
});
