import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@seri/daemon-client";
import { resetCatalogCache } from "@seri/model-catalog";
import { MockLanguageModelV4 } from "ai/test";
import { startDaemon } from "../../src/daemon/server";
import { DISPATCH_TOOL_NAME, READ_ONLY_TOOL_NAMES } from "../../src/provider/tools";
import { SessionDatabase } from "../../src/session/database";
import { fakeRunLoop } from "../cli/fakeRunLoop";
import { streamResult, textOnlyChunks } from "../loop/fixtures";

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
      // A no-tool-call turn does not run the archivist. The cursor must stay at the
      // unarchived prefix, not jump to messages.length (that would make idle flush a no-op).
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
