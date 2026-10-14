import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DaemonClient, isLoopDaemonEvent, snapshotProcessEnv } from "@seri/daemon-client";
import { resetCatalogCache } from "@seri/model-catalog";
import { MockLanguageModelV4 } from "ai/test";
import { profileDir } from "../../src/config/paths";
import { startDaemon } from "../../src/daemon/server";
import { permissionsPath } from "../../src/permissions/store";
import { DISPATCH_TOOL_NAME, READ_ONLY_TOOL_NAMES } from "../../src/provider/tools";
import { SessionDatabase } from "../../src/session/database";
import { _resetBashResolutionForTests, isBashAvailable } from "../../src/tools/bash";
import { fakeRunLoop } from "../cli/fakeRunLoop";
import { streamResult, textOnlyChunks, toolCallChunks } from "../loop/fixtures";

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

function pathWithWrapperFirst(wrapperDir: string): string {
  return `${wrapperDir}${delimiter}${process.env.PATH ?? ""}`;
}

function snapshotWithoutPath(): Record<string, string> {
  const snapshot = snapshotProcessEnv();
  for (const key of Object.keys(snapshot)) {
    if (key.toUpperCase() === "PATH") delete snapshot[key];
  }
  return snapshot;
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

  test("bash in a daemon turn runs the bash first on the client's PATH", async () => {
    _resetBashResolutionForTests();
    const configDir = makeDir();
    process.env.HOME = configDir;
    const work = makeDir();
    const wrapperDir = makeDir();
    const file = join(wrapperDir, "bash");
    writeFileSync(file, "#!/bin/sh\necho seri-client-bash-280\n");
    chmodSync(file, 0o755);
    const { client, capture } = await startProbingDaemon(configDir);
    try {
      await Array.fromAsync(
        client.startTurn({
          task: "probe",
          cwd: work,
          env: { PATH: pathWithWrapperFirst(wrapperDir) },
        }),
      );
      const marked = await capture()!.tools.bash!.execute!({ command: "echo daemon" }, execOpts);
      expect(marked.stdout).toBe("seri-client-bash-280\n");

      await Array.fromAsync(client.startTurn({ task: "probe", cwd: work }));
      const daemon = await capture()!.tools.bash!.execute!({ command: "echo daemon" }, execOpts);
      expect(daemon.stdout).toBe("daemon\n");
    } finally {
      _resetBashResolutionForTests();
    }
  }, 15000);

  test("a client PATH without bash fails the call instead of running the daemon's", async () => {
    const configDir = makeDir();
    process.env.HOME = configDir;
    const work = makeDir();
    const emptyDir = makeDir();
    const { client, capture } = await startProbingDaemon(configDir);
    await Array.fromAsync(
      client.startTurn({
        task: "probe",
        cwd: work,
        env: { PATH: emptyDir },
      }),
    );
    await expect(
      capture()!.tools.bash!.execute!({ command: "echo daemon" }, execOpts),
    ).rejects.toThrow("bash is not on the client's PATH");
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

  test("a client Path without powershell fails instead of running another powershell", async () => {
    const configDir = makeDir();
    process.env.HOME = configDir;
    const work = makeDir();
    const emptyDir = makeDir();
    const { client, capture } = await startProbingDaemon(configDir);
    await Array.fromAsync(
      client.startTurn({
        task: "probe",
        cwd: work,
        env: { ...snapshotWithoutPath(), Path: emptyDir },
      }),
    );
    await expect(
      capture()!.tools.powershell!.execute!({ command: "Write-Output hi" }, execOpts),
    ).rejects.toThrow("powershell is not on the client's PATH");
  }, 15000);
});

function permissionsYaml(
  deny: readonly string[],
  global: readonly string[] = ["write_file"],
): string {
  const denyBlock =
    deny.length === 0 ? "deny: []\n" : `deny:\n${deny.map((entry) => `  - ${entry}\n`).join("")}`;
  const globalBlock =
    global.length === 0
      ? "global: []\n"
      : `global:\n${global.map((entry) => `  - ${entry}\n`).join("")}`;
  return `${globalBlock}projects: {}\n${denyBlock}`;
}

describe("client permission profile", () => {
  test("a named profile's deny blocks write_file ../x; an omitted profile still writes it", async () => {
    const configDir = makeDir();
    process.env.HOME = configDir;
    const root = makeDir();
    const work = join(root, "proj");
    mkdirSync(work);
    const outside = join(root, "x");
    const posixOutside = outside.replaceAll("\\", "/");
    writeFileSync(permissionsPath(configDir), permissionsYaml([]));
    const strictDir = profileDir("strict");
    mkdirSync(strictDir, { recursive: true });
    writeFileSync(permissionsPath(strictDir), permissionsYaml([`write_file(${posixOutside})`]));

    const daemon = await startDaemon({
      configDir,
      idleMs: 0,
      deps: {
        getGroqModel: () =>
          new MockLanguageModelV4({
            doStream: [
              streamResult(
                toolCallChunks("call-1", "write_file", { path: "../x", content: "outside" }),
              ),
              streamResult(textOnlyChunks("Done")),
            ],
          }),
        loadAgentsFile: () => "",
      },
    });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });

    async function runTurn(request: Parameters<DaemonClient["startTurn"]>[0]) {
      const events = [];
      for await (const event of client.startTurn(request)) {
        events.push(event);
        if (event.event.type === "approval-request" && typeof event.event.requestId === "string") {
          await client.approve(event.turnId, event.event.requestId, "once");
        }
      }
      return events;
    }

    const strictEvents = await runTurn({ task: "write", cwd: work, profile: "strict" });
    expect(existsSync(outside)).toBe(false);
    expect(
      strictEvents.some(
        (event) =>
          isLoopDaemonEvent(event.event) &&
          event.event.value.type === "permission-denied" &&
          event.event.value.name === "write_file" &&
          event.event.value.reason === "blocked",
      ),
    ).toBe(true);

    const omittedEvents = await runTurn({ task: "write", cwd: work });
    expect(existsSync(outside)).toBe(true);
    expect(
      omittedEvents.some(
        (event) => isLoopDaemonEvent(event.event) && event.event.value.type === "permission-denied",
      ),
    ).toBe(false);
  });

  test("two concurrent turns each keep their own path denials", async () => {
    const configDir = makeDir();
    process.env.HOME = configDir;
    const root = makeDir();
    const work = join(root, "proj");
    mkdirSync(work);
    const posixOutside = join(root, "x").replaceAll("\\", "/");
    writeFileSync(permissionsPath(configDir), permissionsYaml([]));
    const strictDir = profileDir("strict");
    mkdirSync(strictDir, { recursive: true });
    writeFileSync(permissionsPath(strictDir), permissionsYaml([`write_file(${posixOutside})`]));

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
    await Promise.all([
      Array.fromAsync(client.startTurn({ task: "strict", cwd: work, profile: "strict" })),
      Array.fromAsync(client.startTurn({ task: "open", cwd: work })),
    ]);
    expect(captured).toHaveLength(2);
    const denials = captured.map((opts) => opts.pathDenials ?? []);
    expect(denials).toContainEqual([{ tool: "write_file", pattern: posixOutside }]);
    expect(denials).toContainEqual([]);
  });

  test("a named profile without a write_file grant asks; the daemon grant still writes", async () => {
    const configDir = makeDir();
    process.env.HOME = configDir;
    const work = makeDir();
    const inside = join(work, "in.txt");
    writeFileSync(permissionsPath(configDir), permissionsYaml([], ["write_file"]));
    const strictDir = profileDir("strict");
    mkdirSync(strictDir, { recursive: true });
    writeFileSync(permissionsPath(strictDir), permissionsYaml([], []));

    const daemon = await startDaemon({
      configDir,
      idleMs: 0,
      deps: {
        getGroqModel: () =>
          new MockLanguageModelV4({
            doStream: [
              streamResult(
                toolCallChunks("call-1", "write_file", { path: "in.txt", content: "inside" }),
              ),
              streamResult(textOnlyChunks("Done")),
              streamResult(
                toolCallChunks("call-2", "write_file", { path: "in.txt", content: "inside" }),
              ),
              streamResult(textOnlyChunks("Done")),
            ],
          }),
        loadAgentsFile: () => "",
      },
    });
    stop = daemon.stop;
    const client = new DaemonClient({ endpoint: daemon.endpoint, token: daemon.token });

    const strictEvents = [];
    for await (const event of client.startTurn({
      task: "write",
      cwd: work,
      profile: "strict",
      permissionPrompts: "none",
    })) {
      strictEvents.push(event);
    }
    expect(existsSync(inside)).toBe(false);
    expect(
      strictEvents.some(
        (event) =>
          isLoopDaemonEvent(event.event) &&
          event.event.value.type === "permission-denied" &&
          event.event.value.name === "write_file",
      ),
    ).toBe(true);

    await Array.fromAsync(
      client.startTurn({ task: "write", cwd: work, permissionPrompts: "none" }),
    );
    expect(existsSync(inside)).toBe(true);
  });
});

function writeLogFooHooks(configDir: string): void {
  const hooksDir = join(configDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "hooks.yaml"), "hooks:\n  PreToolUse:\n    - script: log-foo\n");
  writeFileSync(join(hooksDir, "log-foo.sh"), '#!/usr/bin/env bash\necho "$FOO" >&2\nexit 2\n');
  writeFileSync(join(hooksDir, "log-foo.ps1"), "[Console]::Error.WriteLine($env:FOO)\nexit 2\n");
}

describe("client env (hooks)", () => {
  const originalFoo = process.env.FOO;

  afterEach(() => {
    if (originalFoo === undefined) delete process.env.FOO;
    else process.env.FOO = originalFoo;
  });

  test("a PreToolUse hook in a daemon turn sees the client's FOO", async () => {
    process.env.FOO = "daemon-a";
    const configDir = makeDir();
    process.env.HOME = configDir;
    writeLogFooHooks(configDir);
    const work = makeDir();
    const { client, capture } = await startProbingDaemon(configDir);
    await Array.fromAsync(
      client.startTurn({
        task: "probe",
        cwd: work,
        env: { ...snapshotProcessEnv(), FOO: FOO_PROBE },
      }),
    );
    const hook = capture()?.onBeforeTool;
    expect(hook).toBeDefined();
    const outcome = await hook!("bash", { command: "echo hi" });
    expect(outcome.block).toBe(FOO_PROBE);
    expect(process.env.FOO).toBe("daemon-a");
  }, 20000);

  test("a turn with no env still sees the daemon's FOO in a PreToolUse hook", async () => {
    process.env.FOO = "daemon-a";
    const configDir = makeDir();
    process.env.HOME = configDir;
    writeLogFooHooks(configDir);
    const work = makeDir();
    const { client, capture } = await startProbingDaemon(configDir);
    await Array.fromAsync(client.startTurn({ task: "probe", cwd: work }));
    const hook = capture()?.onBeforeTool;
    expect(hook).toBeDefined();
    const outcome = await hook!("bash", { command: "echo hi" });
    expect(outcome.block).toBe("daemon-a");
  }, 20000);
});
