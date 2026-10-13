import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, snapshotProcessEnv } from "@seri/daemon-client";
import { resetCatalogCache } from "@seri/model-catalog";
import { MockLanguageModelV4 } from "ai/test";
import { startDaemon } from "../../src/daemon/server";
import type { runLoop } from "../../src/loop/loop";
import * as mcpClient from "../../src/mcp/client";
import { serverIdentity, writeCatalogCache } from "../../src/mcp/registry";
import { DISPATCH_TOOL_NAME, READ_ONLY_TOOL_NAMES } from "../../src/provider/tools";
import { SessionDatabase } from "../../src/session/database";
import { isBashAvailable } from "../../src/tools/bash";
import { fakeRunLoop } from "../cli/fakeRunLoop";
import { streamResult, textOnlyChunks } from "../loop/fixtures";

type RunLoopOpts = Parameters<typeof runLoop>[0];

let dirs: string[] = [];
let stop: (() => Promise<void>) | undefined;
const originalHome = process.env.HOME;
const originalDisable = process.env.SERI_DISABLE_MODELS_FETCH;
const originalKey = process.env.GROQ_API_KEY;

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-daemon-prod-"));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  resetCatalogCache();
  process.env.SERI_DISABLE_MODELS_FETCH = "1";
  delete process.env.GROQ_API_KEY;
});

afterEach(async () => {
  if (stop !== undefined) {
    await stop();
    stop = undefined;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDisable === undefined) delete process.env.SERI_DISABLE_MODELS_FETCH;
  else process.env.SERI_DISABLE_MODELS_FETCH = originalDisable;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  resetCatalogCache();
});

describe("production daemon wiring", () => {
  test("default executeTurn drives runLoop against the session cwd", async () => {
    const configDir = makeDir();
    process.env.HOME = configDir;
    const work = makeDir();
    writeFileSync(join(work, "note.txt"), "session-copy");
    const { fake, capture } = fakeRunLoop([
      { type: "text-delta", text: "ready" },
      { type: "done", reason: "no-tool-call" },
    ]);
    const daemon = await startDaemon({
      configDir,
      idleMs: 0,
      deps: {
        runLoop: fake,
        getGroqModel: () =>
          new MockLanguageModelV4({
            doStream: async () => streamResult(textOnlyChunks("ready")),
          }),
        loadAgentsFile: () => "",
      },
    });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const events = [];
    for await (const event of client.startTurn({ task: "say ready", cwd: work })) {
      events.push(event);
    }
    expect(events.at(-1)?.event).toEqual({ type: "turn-complete", exitCode: 0 });
    const opts = capture();
    expect(opts).toBeDefined();
    expect(opts?.messages.some((message) => message.role === "user")).toBe(true);
    const read = await opts?.tools.read_file?.execute?.(
      { path: "note.txt" },
      { toolCallId: "t", messages: [], context: {} },
    );
    expect(read).toBe("session-copy");
    expect(process.cwd()).not.toBe(work);
    const sessionId = events[0]?.sessionId;
    expect(sessionId).toBeDefined();
    const probe = new SessionDatabase(configDir);
    try {
      const stored = probe.loadSession(sessionId!);
      expect(stored).toBeDefined();

      expect(probe.getArchivistCursor(sessionId!)).toBe(0);
      expect(stored!.messages.length).toBeGreaterThan(0);
    } finally {
      probe.close();
    }
  });

  test("default runScheduled calls runLoop with only the read-only tools", async () => {
    const configDir = makeDir();
    process.env.HOME = configDir;
    const cwd = makeDir();
    const { fake, capture } = fakeRunLoop([
      { type: "text-delta", text: "ok" },
      { type: "done", reason: "no-tool-call" },
    ]);
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const daemon = await startDaemon({
      configDir,
      idleMs: 0,
      now: () => now,
      tickMs: 60_000,
      executeTurn: async (input) => {
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
      deps: {
        runLoop: fake,
        getGroqModel: () =>
          new MockLanguageModelV4({
            doStream: async () => streamResult(textOnlyChunks("ok")),
          }),
        loadAgentsFile: () => "",
      },
    });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const created = (await client.createSchedule({
      task: "report",
      cwd,
      timing: { kind: "once", at: "2026-01-01T00:00:00.000Z" },
      allowModelReads: true,
    })) as { id: string };
    await daemon.scheduler.tick();
    const names = Object.keys(capture()?.tools ?? {}).sort();
    expect(names).toEqual([...READ_ONLY_TOOL_NAMES].sort());
    expect(names.includes("write_file")).toBe(false);
    expect(DISPATCH_TOOL_NAME in (capture()?.tools ?? {})).toBe(false);
    expect(capture()?.system).toContain("You are powered by the model named");
    expect(capture()?.permissionMode).toBe("read-only");
    const runs = (await client.scheduleRuns(created.id)) as { runs: { response: string }[] };
    expect(runs.runs[0]?.response).toBe("ok");
  });

  test("default idle flush advances the archivist cursor before eviction", async () => {
    const configDir = makeDir();
    process.env.HOME = configDir;
    const database = new SessionDatabase(configDir);
    database.saveSession({
      id: "sess-idle",
      cwd: configDir,
      systemPrompt: "",
      permissionMode: "approve-each",
      messages: [{ role: "user", content: "hello there" }],
    });
    database.close();
    const daemon = await startDaemon({
      configDir,
      idleMs: 40,
      executeTurn: async (input) => {
        input.emitLoop({ type: "done", reason: "no-tool-call" });
        return { exitCode: 0 };
      },
      deps: {
        getGroqModel: () =>
          new MockLanguageModelV4({
            doStream: async () => streamResult(textOnlyChunks("nothing to store")),
          }),
        runLoop: fakeRunLoop([{ type: "done", reason: "no-tool-call" }]).fake,
        loadAgentsFile: () => "",
      },
    });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    await Array.fromAsync(client.startTurn({ task: "hi", sessionId: "sess-idle" }));
    const deadline = Date.now() + 2000;
    let cursor = 0;
    while (Date.now() < deadline) {
      const probe = new SessionDatabase(configDir);
      cursor = probe.getArchivistCursor("sess-idle");
      probe.close();
      if (cursor === 1) break;
      await Bun.sleep(20);
    }
    expect(cursor).toBe(1);
  });
});

const FOO_PROBE = "seri-env-probe-b";
const execOpts = { toolCallId: "t", messages: [], context: { rewindTo: 0 } };

async function startProbingDaemon(configDir: string) {
  const { fake, capture } = fakeRunLoop([{ type: "done", reason: "no-tool-call" }]);
  const daemon = await startDaemon({
    configDir,
    idleMs: 0,
    deps: {
      runLoop: fake,
      getGroqModel: () =>
        new MockLanguageModelV4({
          doStream: async () => streamResult(textOnlyChunks("ready")),
        }),
      loadAgentsFile: () => "",
    },
  });
  stop = daemon.stop;
  return {
    client: new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token }),
    capture,
  };
}

describe.skipIf(process.platform === "win32" || !isBashAvailable())("client env", () => {
  const originalFoo = process.env.FOO;

  afterEach(() => {
    if (originalFoo === undefined) delete process.env.FOO;
    else process.env.FOO = originalFoo;
  });

  test("bash in a daemon turn sees the client's FOO and cwd, not the daemon's", async () => {
    process.env.FOO = "daemon-a";
    const configDir = makeDir();
    process.env.HOME = configDir;
    const work = makeDir();
    const { client, capture } = await startProbingDaemon(configDir);
    const events = [];
    for await (const event of client.startTurn({
      task: "probe",
      cwd: work,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FOO: FOO_PROBE },
    })) {
      events.push(event);
    }
    const out = await capture()!.tools.bash!.execute!({ command: "echo $FOO; pwd" }, execOpts);
    expect(out.stdout).toBe(`${FOO_PROBE}\n${realpathSync(work)}\n`);
    expect(process.env.FOO).toBe("daemon-a");

    const sessionId = events[0]?.sessionId;
    const turnId = events[0]?.turnId;
    expect(sessionId).toBeDefined();
    expect(turnId).toBeDefined();
    const probe = new SessionDatabase(configDir);
    try {
      expect(JSON.stringify(probe.loadSession(sessionId!))).not.toContain(FOO_PROBE);
      expect(JSON.stringify(probe.listDaemonEventsAfter(turnId!, -1))).not.toContain(FOO_PROBE);
    } finally {
      probe.close();
    }
  }, 15000);

  test("a turn with no env still sees the daemon's FOO", async () => {
    process.env.FOO = "daemon-a";
    const configDir = makeDir();
    process.env.HOME = configDir;
    const work = makeDir();
    const { client, capture } = await startProbingDaemon(configDir);
    await Array.fromAsync(client.startTurn({ task: "probe", cwd: work }));
    const out = await capture()!.tools.bash!.execute!({ command: "echo $FOO" }, execOpts);
    expect(out.stdout).toBe("daemon-a\n");
  }, 15000);

  test("replace, not merge: a client env without FOO prints an empty FOO", async () => {
    process.env.FOO = "daemon-a";
    const configDir = makeDir();
    process.env.HOME = configDir;
    const work = makeDir();
    const { client, capture } = await startProbingDaemon(configDir);
    await Array.fromAsync(
      client.startTurn({
        task: "probe",
        cwd: work,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      }),
    );
    const out = await capture()!.tools.bash!.execute!({ command: "echo $FOO" }, execOpts);
    expect(out.stdout).toBe("\n");
  }, 15000);

  test("two concurrent turns each see their own env", async () => {
    process.env.FOO = "daemon-a";
    const configDir = makeDir();
    process.env.HOME = configDir;
    const captured: NonNullable<ReturnType<ReturnType<typeof fakeRunLoop>["capture"]>>[] = [];
    async function* fake(opts: NonNullable<ReturnType<ReturnType<typeof fakeRunLoop>["capture"]>>) {
      captured.push(opts);
      yield { type: "done" as const, reason: "no-tool-call" as const };
      return opts.messages;
    }
    const daemon = await startDaemon({
      configDir,
      idleMs: 0,
      deps: {
        runLoop: fake,
        getGroqModel: () =>
          new MockLanguageModelV4({
            doStream: async () => streamResult(textOnlyChunks("ready")),
          }),
        loadAgentsFile: () => "",
      },
    });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const workOne = makeDir();
    const workTwo = makeDir();
    await Promise.all([
      Array.fromAsync(
        client.startTurn({
          task: "one",
          cwd: workOne,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FOO: "one" },
        }),
      ),
      Array.fromAsync(
        client.startTurn({
          task: "two",
          cwd: workTwo,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FOO: "two" },
        }),
      ),
    ]);
    expect(captured).toHaveLength(2);
    const [first, second] = await Promise.all(
      captured.map((opts) => opts!.tools.bash!.execute!({ command: "echo $FOO" }, execOpts)),
    );
    expect([first.stdout, second.stdout].sort()).toEqual(["one\n", "two\n"]);
  }, 15000);
});

describe.skipIf(process.platform !== "win32")("client env (powershell)", () => {
  const originalFoo = process.env.FOO;

  afterEach(() => {
    if (originalFoo === undefined) delete process.env.FOO;
    else process.env.FOO = originalFoo;
  });

  test("powershell in a daemon turn sees the client's FOO", async () => {
    process.env.FOO = "daemon-a";
    const configDir = makeDir();
    process.env.HOME = configDir;
    const work = makeDir();
    const { client, capture } = await startProbingDaemon(configDir);
    await Array.fromAsync(
      client.startTurn({
        task: "probe",
        cwd: work,
        env: { ...snapshotProcessEnv(), FOO: FOO_PROBE },
      }),
    );
    const out = await capture()!.tools.powershell!.execute!(
      { command: "Write-Output $env:FOO" },
      execOpts,
    );
    expect(out.stdout.trim()).toBe(FOO_PROBE);
    expect(process.env.FOO).toBe("daemon-a");
  }, 15000);
});

const PROBE_SERVER = [
  "servers:",
  "  probe:",
  "    url: https://mcp.probe.test/mcp",
  "    headers:",
  "      Authorization: Bearer ${env:SERI_TEST_MCP_TOKEN}",
  "",
].join("\n");

describe("client env reaches MCP headers", () => {
  const originalToken = process.env.SERI_TEST_MCP_TOKEN;
  const authorizations: string[] = [];
  let createSpy: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    authorizations.length = 0;
    process.env.SERI_TEST_MCP_TOKEN = "a";
    const realCreate = mcpClient.createMcpClients;
    createSpy = spyOn(mcpClient, "createMcpClients").mockImplementation(() => {
      return realCreate(async (spec) => {
        const authorization = spec.headers.Authorization;
        if (authorization !== undefined) authorizations.push(authorization);
        return {
          listTools: async () => [{ name: "echo", description: "Echo.", inputSchema: {} }],
          callTool: async () => authorization ?? "",
          close: async () => {},
        };
      });
    });
  });

  afterEach(() => {
    createSpy?.mockRestore();
    createSpy = undefined;
    if (originalToken === undefined) delete process.env.SERI_TEST_MCP_TOKEN;
    else process.env.SERI_TEST_MCP_TOKEN = originalToken;
  });

  function trustProbe(configDir: string, authorization: string): void {
    mkdirSync(join(configDir, "mcp"), { recursive: true });
    writeFileSync(join(configDir, "mcp", "servers.yaml"), PROBE_SERVER);
    writeCatalogCache(configDir, {
      server: "probe",
      identity: serverIdentity({
        url: "https://mcp.probe.test/mcp",
        headers: { Authorization: authorization },
      }),
      fetchedAt: new Date().toISOString(),
      tools: [
        {
          name: "echo",
          toolName: "mcp_probe_echo",
          description: "Echo.",
          inputSchema: {},
        },
      ],
    });
  }

  async function runTurn(
    configDir: string,
    env: Record<string, string> | undefined,
  ): Promise<{
    sawMcp: boolean;
    output: unknown;
    exitCode: number | undefined;
  }> {
    process.env.HOME = configDir;
    let sawMcp = false;
    let output: unknown;
    const daemon = await startDaemon({
      configDir,
      idleMs: 0,
      deps: {
        runLoop: async function* probe(opts: RunLoopOpts) {
          const mcp = opts.tools.mcp;
          sawMcp = mcp !== undefined;
          if (mcp?.execute !== undefined) {
            output = await mcp.execute({ tool: "mcp_probe_echo" }, execOpts);
          }
          yield { type: "done", reason: "no-tool-call" };
          return opts.messages;
        },
        getGroqModel: () =>
          new MockLanguageModelV4({
            doStream: async () => streamResult(textOnlyChunks("ready")),
          }),
        loadAgentsFile: () => "",
      },
    });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });
    const work = makeDir();
    const events = [];
    for await (const event of client.startTurn({
      task: "probe",
      cwd: work,
      ...(env === undefined ? {} : { env }),
    })) {
      events.push(event);
    }
    const last = events.at(-1)?.event;
    return {
      sawMcp,
      output,
      exitCode: last?.type === "turn-complete" ? last.exitCode : undefined,
    };
  }

  test("an attach whose snapshot matches the trusted bearer sends that bearer", async () => {
    const configDir = makeDir();
    process.env.HOME = configDir;
    trustProbe(configDir, "Bearer b");
    const result = await runTurn(configDir, {
      ...snapshotProcessEnv(),
      SERI_TEST_MCP_TOKEN: "b",
    });
    expect(result.exitCode).toBe(0);
    expect(result.sawMcp).toBe(true);
    expect(result.output).toBe("Bearer b");
    expect(authorizations).toEqual(["Bearer b"]);
  });

  test("a turn with no env sends the daemon process bearer", async () => {
    const configDir = makeDir();
    process.env.HOME = configDir;
    trustProbe(configDir, "Bearer a");
    const result = await runTurn(configDir, undefined);
    expect(result.exitCode).toBe(0);
    expect(result.sawMcp).toBe(true);
    expect(result.output).toBe("Bearer a");
    expect(authorizations).toEqual(["Bearer a"]);
  });

  test("an attach that disagrees with the trusted bearer sends nothing", async () => {
    const configDir = makeDir();
    process.env.HOME = configDir;
    trustProbe(configDir, "Bearer a");
    const result = await runTurn(configDir, {
      ...snapshotProcessEnv(),
      SERI_TEST_MCP_TOKEN: "b",
    });
    expect(result.exitCode).toBe(0);
    expect(result.sawMcp).toBe(false);
    expect(authorizations).toEqual([]);
  });
});
