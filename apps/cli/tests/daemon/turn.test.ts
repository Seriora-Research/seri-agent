import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCatalogCache } from "@seri/model-catalog";
import { MockLanguageModelV4 } from "ai/test";
import { createAttendedExecuteTurn } from "../../src/daemon/turn";
import * as mcpClient from "../../src/mcp/client";
import { SessionDatabase } from "../../src/session/database";
import { fakeRunLoop } from "../cli/fakeRunLoop";
import { streamResult, textOnlyChunks } from "../loop/fixtures";

let dirs: string[] = [];
let databases: SessionDatabase[] = [];
let closeSpy: ReturnType<typeof spyOn> | undefined;

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-daemon-turn-"));
  dirs.push(dir);
  return dir;
}

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
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
  closeSpy?.mockRestore();
  closeSpy = undefined;
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

function setupExecute(runLoop?: ReturnType<typeof fakeRunLoop>["fake"]) {
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
  test("closes the prepareSession mcp pool after the turn", async () => {
    closeSpy = spyOn(mcpClient, "closeMcpClients");
    const { execute, sessionId, cwd } = setupExecute();
    const result = await startTurn(execute, sessionId, cwd, "turn-1");
    expect(result.exitCode).toBe(0);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test("closes a fresh pool on every attended turn", async () => {
    closeSpy = spyOn(mcpClient, "closeMcpClients");
    const { execute, sessionId, cwd } = setupExecute();
    expect((await startTurn(execute, sessionId, cwd, "turn-1")).exitCode).toBe(0);
    expect((await startTurn(execute, sessionId, cwd, "turn-2")).exitCode).toBe(0);
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  test("closes after the loop returns, not before", async () => {
    const order: string[] = [];
    const originalClose = mcpClient.closeMcpClients;
    closeSpy = spyOn(mcpClient, "closeMcpClients").mockImplementation((clients, onWarning) => {
      order.push("close");
      originalClose(clients, onWarning);
    });
    const { fake } = fakeRunLoop([{ type: "done", reason: "no-tool-call" }]);
    async function* tracked(opts: Parameters<typeof fake>[0]) {
      order.push("loop");
      return yield* fake(opts);
    }
    const { execute, sessionId, cwd } = setupExecute(tracked);
    expect((await startTurn(execute, sessionId, cwd, "turn-1")).exitCode).toBe(0);
    expect(order).toEqual(["loop", "close"]);
  });
});
