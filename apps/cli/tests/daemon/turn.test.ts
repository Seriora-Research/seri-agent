import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCatalogCache } from "@seri/model-catalog";
import { MockLanguageModelV4 } from "ai/test";
import type { CliDeps } from "../../src/cli";
import { createAttendedExecuteTurn } from "../../src/daemon/turn";
import * as mcpClient from "../../src/mcp/client";
import { callMcpTool, type McpClientHandle, type McpClients } from "../../src/mcp/client";
import type { McpServerSpec } from "../../src/mcp/types";
import { SessionDatabase } from "../../src/session/database";
import { fakeRunLoop } from "../cli/fakeRunLoop";
import { streamResult, textOnlyChunks } from "../loop/fixtures";

let dirs: string[] = [];
let databases: SessionDatabase[] = [];
let spies: Array<{ mockRestore: () => void }> = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-daemon-turn-"));
  dirs.push(dir);
  return dir;
}

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

function macrotick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function spec(): McpServerSpec {
  return {
    name: "ghost",
    url: "https://127.0.0.1:1/mcp",
    headers: {},
    source: "project",
    filePath: "x",
  };
}

const originalKey = process.env.GROQ_API_KEY;
const originalHome = process.env.HOME;
const originalDisable = process.env.SERI_DISABLE_MODELS_FETCH;

beforeEach(() => {
  process.env.GROQ_API_KEY = "fake-test-key";
  process.env.SERI_DISABLE_MODELS_FETCH = "1";
  resetCatalogCache();
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  for (const database of databases) database.close();
  databases = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  restoreEnv("GROQ_API_KEY", originalKey);
  restoreEnv("HOME", originalHome);
  restoreEnv("SERI_DISABLE_MODELS_FETCH", originalDisable);
  resetCatalogCache();
});

function openDatabase(configDir: string): SessionDatabase {
  const database = new SessionDatabase(configDir);
  databases.push(database);
  return database;
}

function instrumentPools() {
  const pools: McpClients[] = [];
  let closeCalls = 0;
  const realCreate = mcpClient.createMcpClients;
  const createSpy = spyOn(mcpClient, "createMcpClients").mockImplementation(() => {
    const handle: McpClientHandle = {
      listTools: async () => [{ name: "web_search", description: "", inputSchema: {} }],
      callTool: async () => "",
      close: async () => {
        closeCalls++;
      },
    };
    const pool = realCreate(async () => handle);
    pools.push(pool);
    return pool;
  });
  spies.push(createSpy);
  return {
    pools,
    closeCount: () => closeCalls,
  };
}

function setupExecute(runLoop?: NonNullable<CliDeps["runLoop"]>) {
  const configDir = makeDir();
  process.env.HOME = configDir;
  const cwd = makeDir();
  const database = openDatabase(configDir);
  const sessionId = "sess-mcp-close";
  database.saveSession({
    id: sessionId,
    cwd,
    systemPrompt: "",
    permissionMode: "approve-each",
    messages: [],
  });
  const { fake } = fakeRunLoop([{ type: "done", reason: "no-tool-call" }]);
  const execute = createAttendedExecuteTurn({
    configDir,
    sessionsDir: join(configDir, "sessions"),
    checkpointsDir: join(configDir, "checkpoints"),
    permissionsDir: configDir,
    deps: {
      runLoop: runLoop ?? fake,
      getGroqModel: () =>
        new MockLanguageModelV4({
          doStream: async () => streamResult(textOnlyChunks("ok")),
        }),
      loadAgentsFile: () => "",
      loadExtensions: () => ({
        skills: new Map(),
        rules: new Map(),
        hooks: { registry: new Map() },
      }),
      authConfigDir: configDir,
    },
    database,
  });
  return { execute, sessionId, cwd };
}

function startTurn(
  execute: ReturnType<typeof createAttendedExecuteTurn>,
  sessionId: string,
  cwd: string,
  turnId: string,
) {
  return execute({
    turnId,
    sessionId,
    task: "hi",
    cwd,
    permissionMode: "approve-each",
    signal: new AbortController().signal,
    emitLoop: () => {},
    requestApproval: async () => "no",
  });
}

describe("createAttendedExecuteTurn mcp clients", () => {
  test("closes a dialled handle after the turn, not while the loop is running", async () => {
    const { pools, closeCount } = instrumentPools();
    const { fake } = fakeRunLoop([{ type: "done", reason: "no-tool-call" }]);
    let closesSeenWhileRunning = -1;
    async function* dialThenDone(opts: Parameters<typeof fake>[0]) {
      const pool = pools.at(-1);
      if (pool === undefined) throw new Error("prepareSession did not create an mcp pool");
      await callMcpTool(pool, spec(), "web_search", {});
      await macrotick();
      closesSeenWhileRunning = closeCount();
      return yield* fake(opts);
    }
    const { execute, sessionId, cwd } = setupExecute(dialThenDone);
    expect((await startTurn(execute, sessionId, cwd, "turn-1")).exitCode).toBe(0);
    expect(closesSeenWhileRunning).toBe(0);
    // closeMcpClients is fire-and-forget through two then/catch hops on an already-resolved
    // promise. A macrotask tick is what lets the handle close settle, same as bindSession's test.
    await macrotick();
    expect(closeCount()).toBe(1);
    expect(pools[0]?.handles.size).toBe(0);
  });

  test("closes a dialled handle on every attended turn", async () => {
    const { pools, closeCount } = instrumentPools();
    const { fake } = fakeRunLoop([{ type: "done", reason: "no-tool-call" }]);
    async function* dialThenDone(opts: Parameters<typeof fake>[0]) {
      const pool = pools.at(-1);
      if (pool === undefined) throw new Error("prepareSession did not create an mcp pool");
      await callMcpTool(pool, spec(), "web_search", {});
      return yield* fake(opts);
    }
    const { execute, sessionId, cwd } = setupExecute(dialThenDone);
    expect((await startTurn(execute, sessionId, cwd, "turn-1")).exitCode).toBe(0);
    expect((await startTurn(execute, sessionId, cwd, "turn-2")).exitCode).toBe(0);
    await macrotick();
    expect(pools).toHaveLength(2);
    expect(pools[0]).not.toBe(pools[1]);
    expect(closeCount()).toBe(2);
    expect(pools[0]?.handles.size).toBe(0);
    expect(pools[1]?.handles.size).toBe(0);
  });

  test("closes a dialled handle when the loop throws", async () => {
    const { pools, closeCount } = instrumentPools();
    async function* dialThenThrow() {
      const pool = pools.at(-1);
      if (pool === undefined) throw new Error("prepareSession did not create an mcp pool");
      await callMcpTool(pool, spec(), "web_search", {});
      yield { type: "text-delta" as const, text: "partial" };
      throw new Error("boom");
    }
    const { execute, sessionId, cwd } = setupExecute(dialThenThrow);
    await expect(startTurn(execute, sessionId, cwd, "turn-1")).rejects.toThrow("boom");
    await macrotick();
    expect(closeCount()).toBe(1);
    expect(pools[0]?.handles.size).toBe(0);
  });
});
