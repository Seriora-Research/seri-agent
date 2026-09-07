import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { PassThrough } from "node:stream";
import { resetCatalogCache } from "@seri/model-catalog";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { loadAgentsFile } from "../../src/agents/loadAgentsFile";
import { buildSystemPrompt } from "../../src/agents/systemPrompt";
import { AUTH_FILENAME, saveAuthSession } from "../../src/auth/authStore";
import { saveCodexSubscription } from "../../src/auth/codexAuthStore";
import { ignoreCodexSubscription } from "../../src/auth/codexIgnore";
import { ignoreSeriPlan } from "../../src/auth/seriIgnore";
import { saveXaiSubscription } from "../../src/auth/xaiAuthStore";
import { checkpointStoreDir, createCheckpointer, readLog } from "../../src/checkpoint/checkpoint";
import { isGitAvailable, projectRoot } from "../../src/checkpoint/shadowGit";
import { recordWrite } from "../../src/checkpoint/writeLedger";
import {
  addCost,
  chooseInterfaceOutput,
  needsGuidedSetup,
  run,
  SLASH_COMMANDS,
  tuiPresenter,
} from "../../src/cli";
import { printUsage, recoveryLines, USAGE, undoPlanLines } from "../../src/cli/output";
import { loadConfig, setConfigValue } from "../../src/config/config";
import { persistDefaultModel } from "../../src/provider/defaults";
import { getConfigDir, getTrajectoriesDir } from "../../src/config/paths";
import type { ApprovalAnswer, LoopEvent, runLoop } from "../../src/loop/loop";
import { loadGrants, permissionsPath, projectKey } from "../../src/permissions/store";
import type { CostReport } from "../../src/provider/cost";
import { getGroqModel } from "../../src/provider/groq";
import { configuredProviders, PROVIDER_API_KEY_NAMES } from "../../src/provider/keys";
import { DISPATCH_TOOL_NAME, toolDefinitions } from "../../src/provider/tools";
import { ASK_USER_TOOL_NAME } from "../../src/ask-user/types";
import {
  listSessionIds,
  loadSession,
  type SessionState,
  saveSession,
} from "../../src/session/session";
import { deliverSignal, onSignalCancel } from "../../src/signals";
import {
  createTrajectoryWriter,
  readTrajectory,
  type TrajectoryWriter,
} from "../../src/trajectory/writer";
import type { CheckOutcome } from "../../src/verify/run";
import { fakeRunLoop } from "./fakeRunLoop";

type RunLoopOpts = Parameters<typeof runLoop>[0];

function testPresenter(dirs: { sessionsDir: string }, session?: SessionState<ModelMessage>) {
  return {
    message: (text: string) => console.log(text),
    onPlan: (plan: Parameters<typeof undoPlanLines>[0]) => undoPlanLines(plan),
    restore: ({
      plan,
      message,
    }: {
      plan: Parameters<typeof recoveryLines>[0];
      message: string;
    }) => {
      console.log(message);
      if (plan.restored.length > 0 || plan.deleted.length > 0) recoveryLines(plan);
    },
    sessionUpdated: async (next: SessionState<ModelMessage>) => saveSession(next, dirs.sessionsDir),
    transcriptCleared: () => {},
    usageAccrued: (usage: LanguageModelUsage) =>
      printUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
    cancelled: () => console.log("Compaction cancelled."),
    currentSession: () => session as SessionState<ModelMessage>,
  };
}

async function invokeSlash(
  name: string,
  args: string[],
  dirs: {
    sessionsDir: string;
    checkpointsDir: string;
    configDir: string;
    trajectory?: TrajectoryWriter;
  },
  session?: SessionState<ModelMessage>,
): Promise<void> {
  const command = SLASH_COMMANDS.get(name);
  if (command === undefined) throw new Error(`${name} is not registered`);
  const presenter = testPresenter(dirs, session);
  if (command.needsSession === false) {
    await command.run(args, dirs, presenter);
    return;
  }
  if (session === undefined) throw new Error(`${name} needs a session`);
  await command.run(session, args, dirs, presenter);
}

describe("run (task invocation)", () => {
  const originalKey = process.env.GROQ_API_KEY;
  const originalHome = process.env.HOME;
  const originalDisableModelsFetch = process.env.SERI_DISABLE_MODELS_FETCH;
  let sessionsDir: string;
  let tmpConfigRoot: string;
  const extraTmpDirs: string[] = [];

  function restoreEnv(key: string, original: string | undefined): void {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }

  async function captureLogs(
    invoke: () => Promise<number>,
  ): Promise<{ code: number; logs: string[] }> {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg: string) => logs.push(String(msg));
    console.error = () => {};
    try {
      return { code: await invoke(), logs };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-sessions-"));
    tmpConfigRoot = mkdtempSync(join(tmpdir(), "seri-cli-test-config-"));
    process.env.HOME = tmpConfigRoot;
    resetCatalogCache();
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
  });

  afterEach(() => {
    restoreEnv("GROQ_API_KEY", originalKey);
    restoreEnv("HOME", originalHome);
    restoreEnv("SERI_DISABLE_MODELS_FETCH", originalDisableModelsFetch);
    resetCatalogCache();
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(tmpConfigRoot, { recursive: true, force: true });
    for (const dir of extraTmpDirs) rmSync(dir, { recursive: true, force: true });
    extraTmpDirs.length = 0;
  });

  test("missing GROQ_API_KEY returns a non-zero exit code instead of crashing", async () => {
    delete process.env.GROQ_API_KEY;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));

    let code: number;
    try {
      code = await run(["do", "a", "task"], {
        sessionsDir,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
      });
    } finally {
      console.error = originalError;
    }

    expect(code).not.toBe(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("reroutes to a sibling provider with a key when the requested one has none, and warns (non-interactive path)", async () => {
    delete process.env.GROQ_API_KEY;
    process.env.OPENROUTER_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));

    let code: number;
    try {
      code = await run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      });
    } finally {
      console.error = originalError;
      delete process.env.OPENROUTER_API_KEY;
    }

    expect(code).toBe(0);
    expect(capture()?.provider).toBe("openrouter");
    expect(capture()?.modelId).toBe("openai/gpt-oss-120b");
    expect(errors.some((line) => line.includes("routing openai/gpt-oss-120b via openrouter"))).toBe(
      true,
    );
    expect(errors.some((line) => /groq/i.test(line))).toBe(false);
  });

  test("reroutes to a sibling provider with a key when an EXPLICITLY requested one has none, and blames it by name (non-interactive path)", async () => {
    delete process.env.GROQ_API_KEY;
    process.env.OPENROUTER_API_KEY = "fake-test-key";
    setConfigValue("SERI_PROVIDER", "groq");
    const { fake, capture } = fakeRunLoop();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));

    let code: number;
    try {
      code = await run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      });
    } finally {
      console.error = originalError;
      delete process.env.OPENROUTER_API_KEY;
    }

    expect(code).toBe(0);
    expect(capture()?.provider).toBe("openrouter");
    expect(capture()?.modelId).toBe("openai/gpt-oss-120b");
    expect(
      errors.some(
        (line) =>
          line.includes("routing openai/gpt-oss-120b via openrouter") &&
          line.includes("no Groq key configured"),
      ),
    ).toBe(true);
  });

  test("a resumed session's reroute notice blames its own persisted provider, not the one it reroutes to", async () => {
    delete process.env.GROQ_API_KEY;
    const seeded: SessionState = {
      id: "reroute-on-resume",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      model: "openai/gpt-oss-120b",
      provider: "openrouter",
      messages: [],
    };
    saveSession(seeded, sessionsDir);

    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));

    let code: number;
    try {
      code = await run(["--resume", "reroute-on-resume", "another", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      });
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(0);
    expect(
      errors.some(
        (line) =>
          line.includes("routing openai/gpt-oss-120b via groq") &&
          line.includes("no OpenRouter key configured"),
      ),
    ).toBe(true);
  });

  test("routes via the gateway when no local key covers the model, and warns (non-interactive path)", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.SERI_GATEWAY_URL = "http://localhost:9/api/gateway";
    saveAuthSession(
      {
        accessToken: "at-1",
        refreshToken: "rt-1",
        userId: "user_1",
        email: "a@example.com",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      },
      getConfigDir(),
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/account-status")) {
        return new Response(JSON.stringify({ plan: "pro" }), { status: 200 });
      }
      return realFetch(input);
    }) as typeof fetch;

    const { fake, capture } = fakeRunLoop();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));

    let code: number;
    try {
      code = await run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      });
    } finally {
      console.error = originalError;
      globalThis.fetch = realFetch;
      delete process.env.SERI_GATEWAY_URL;
    }

    expect(code).toBe(0);
    expect(capture()?.provider).toBe("openrouter");
    expect(capture()?.modelId).toBe("openai/gpt-oss-120b");
    expect(
      errors.some((line) => line.includes("routing openai/gpt-oss-120b on your seri plan")),
    ).toBe(true);
    expect(errors.some((line) => /openrouter/i.test(line))).toBe(false);
    expect(errors.some((line) => line.includes("key configured"))).toBe(false);
  });

  test("routes via the gateway on a resumed session without blaming OpenRouter", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.SERI_GATEWAY_URL = "http://localhost:9/api/gateway";
    const seeded: SessionState = {
      id: "gateway-on-resume",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      model: "openai/gpt-oss-120b",
      provider: "openrouter",
      messages: [],
    };
    saveSession(seeded, sessionsDir);
    saveAuthSession(
      {
        accessToken: "at-1",
        refreshToken: "rt-1",
        userId: "user_1",
        email: "a@example.com",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      },
      getConfigDir(),
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/account-status")) {
        return new Response(JSON.stringify({ plan: "pro" }), { status: 200 });
      }
      return realFetch(input);
    }) as typeof fetch;

    const { fake, capture } = fakeRunLoop();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));

    let code: number;
    try {
      code = await run(["--resume", "gateway-on-resume", "another", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      });
    } finally {
      console.error = originalError;
      globalThis.fetch = realFetch;
      delete process.env.SERI_GATEWAY_URL;
    }

    expect(code).toBe(0);
    expect(capture()?.provider).toBe("openrouter");
    expect(
      errors.some((line) => line.includes("routing openai/gpt-oss-120b on your seri plan")),
    ).toBe(true);
    expect(errors.some((line) => /openrouter/i.test(line))).toBe(false);
    expect(errors.some((line) => line.includes("key configured"))).toBe(false);
  });

  test("`--continue` with no task resumes the most recent session without appending a message", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const older: SessionState = {
      id: "older",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [{ role: "user", content: "old task" }],
    };
    const newer: SessionState = {
      id: "newer",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [{ role: "user", content: "new task" }],
    };
    saveSession(older, sessionsDir);
    saveSession(newer, sessionsDir);

    const { fake, capture } = fakeRunLoop();

    await captureLogs(() =>
      run(["--continue"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(capture()?.messages).toEqual([{ role: "user", content: "new task" }]);
    expect(listSessionIds(sessionsDir)).toHaveLength(2);
  });

  test("non-interactive --continue does not start a turn when the resumed session already has an assistant reply", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const messages: ModelMessage[] = [
      { role: "user", content: "already done" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    saveSession(
      {
        id: "answered",
        cwd: ".",
        systemPrompt: "",
        permissionMode: "read-only",
        messages,
      },
      sessionsDir,
    );
    const { fake, capture } = fakeRunLoop();

    const { code } = await captureLogs(() =>
      run(["--continue"], {
        isTTY: false,
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(0);
    expect(capture()).toBeUndefined();
    expect(loadSession("answered", sessionsDir).messages).toEqual(messages);
  });

  test("`--resume <id>` resumes that session, not the most recent one", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const older: SessionState = {
      id: "older",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [{ role: "user", content: "old task" }],
    };
    const newer: SessionState = {
      id: "newer",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [{ role: "user", content: "new task" }],
    };
    saveSession(older, sessionsDir);
    saveSession(newer, sessionsDir);

    const { fake, capture } = fakeRunLoop();

    await captureLogs(() =>
      run(["--resume", "older"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(capture()?.messages).toEqual([{ role: "user", content: "old task" }]);
  });

  test("constructs runLoop with the expected messages, permissionMode, and tools", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake, capture } = fakeRunLoop();

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));

    let code: number;
    try {
      code = await run(["write", "hello.txt"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      });
    } finally {
      console.log = originalLog;
    }

    expect(code).toBe(0);
    expect(capture()).toBeDefined();
    expect(capture()?.permissionMode).toBe("approve-each");
    expect(Object.keys(capture()?.tools ?? {})).toEqual([
      ...Object.keys(toolDefinitions),
      "dispatch_subagents",
      "todo",
      ASK_USER_TOOL_NAME,
    ]);
    expect(capture()?.tools.write_file).not.toBe(toolDefinitions.write_file);
    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "write hello.txt" });
    expect(capture()?.messages).toHaveLength(1);
    expect(
      capture()?.system?.startsWith(
        buildSystemPrompt({ agentsContent: "", skills: [], rules: [] }),
      ),
    ).toBe(true);
    expect(capture()?.system).toMatch(/You are powered by the model named/);
  });

  test("non-TTY ask_user returns unavailable without hanging", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();
    await captureLogs(() =>
      run(["write", "hello.txt"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );
    const pending = capture()?.tools[ASK_USER_TOOL_NAME]?.execute?.(
      { prompt: "Which?", choices: ["a", "b"] },
      { toolCallId: "t", messages: [], context: {} },
    );
    const raced = await Promise.race([
      Promise.resolve(pending).then(() => "done" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    expect(raced).toBe("done");
    expect(await pending).toEqual({ outcome: "unavailable", reason: "no-human" });
  });

  test("a task with leading/trailing whitespace is trimmed before being sent to the model", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();

    await captureLogs(() =>
      run(["  do a task  "], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(capture()?.messages).toEqual([{ role: "user", content: "do a task" }]);
  });

  test('seri -- "plan this" does not enter plan mode', async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();
    const plansDir = join(tmpConfigRoot, ".seri", "plans");

    const { code } = await captureLogs(() =>
      run(["--", "plan this"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(0);
    expect(capture()?.tools?.ask_plan_questions).toBeUndefined();
    expect(capture()?.tools?.submit_plan).toBeUndefined();
    expect(capture()?.system).not.toContain("You are in plan mode");
    expect(existsSync(plansDir)).toBe(false);
  });

  test("a new session is created in approve-each, and the file on disk says so too", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();

    await captureLogs(() =>
      run(["write", "hello.txt"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(capture()?.permissionMode).toBe("approve-each");
    const createdId = listSessionIds(sessionsDir)[0]!;
    expect(loadSession(createdId, sessionsDir).permissionMode).toBe("approve-each");
  });

  test("--dangerously-skip-permissions reaches runLoop as auto", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();

    await captureLogs(() =>
      run(["--dangerously-skip-permissions", "write", "hello.txt"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(capture()?.permissionMode).toBe("auto");
  });

  test("--dangerously-skip-permissions is not persisted to the session file", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop(answeredTurn);

    await captureLogs(() =>
      run(["--dangerously-skip-permissions", "write", "hello.txt"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    const createdId = listSessionIds(sessionsDir)[0]!;
    expect(loadSession(createdId, sessionsDir).permissionMode).toBe("approve-each");
  });

  test("--permission-prompts none does not change permissionMode", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();

    await captureLogs(() =>
      run(["--permission-prompts", "none", "write", "hello.txt"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(capture()?.permissionMode).toBe("approve-each");
  });

  test("--permission-prompts none is not persisted to the session file", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop(answeredTurn);

    await captureLogs(() =>
      run(["--permission-prompts", "none", "write", "hello.txt"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    const createdId = listSessionIds(sessionsDir)[0]!;
    const session = loadSession(createdId, sessionsDir);
    expect(session.permissionMode).toBe("approve-each");
    expect(JSON.stringify(session)).not.toContain("promptChannel");
    expect(JSON.stringify(session)).not.toContain("permissionPrompts");
  });

  test("--permission-prompts none with --dangerously-skip-permissions reaches runLoop as auto and is not persisted", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop(answeredTurn);

    await captureLogs(() =>
      run(
        ["--permission-prompts", "none", "--dangerously-skip-permissions", "write", "hello.txt"],
        {
          runLoop: fake,
          loadAgentsFile: () => "",
          loadExtensions: () => ({
            skills: new Map(),
            rules: new Map(),
            hooks: { registry: new Map() },
          }),
          sessionsDir,
        },
      ),
    );

    expect(capture()?.permissionMode).toBe("auto");
    const createdId = listSessionIds(sessionsDir)[0]!;
    expect(loadSession(createdId, sessionsDir).permissionMode).toBe("approve-each");
  });

  test("--permission-prompts none omits approvalPrompt; omitting the flag keeps it", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const none = fakeRunLoop();
    const live = fakeRunLoop();
    const deps = {
      loadAgentsFile: () => "",
      loadExtensions: () => ({
        skills: new Map(),
        rules: new Map(),
        hooks: { registry: new Map() },
      }),
      sessionsDir,
    };

    await captureLogs(() =>
      run(["--permission-prompts", "none", "write", "hello.txt"], { ...deps, runLoop: none.fake }),
    );
    expect(none.capture()?.approvalPrompt).toBeUndefined();

    await captureLogs(() => run(["write", "hello.txt"], { ...deps, runLoop: live.fake }));
    expect(typeof live.capture()?.approvalPrompt).toBe("function");
  });

  test("the tool-allowed event prints which tool was approved for the rest of the run", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop([
      { type: "tool-allowed", name: "bash" },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(logs.some((line) => line.includes("bash"))).toBe(true);
  });

  test("a tool-allowed event for bash writes nothing to the permanent store", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const permissionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-permissions-"));
    extraTmpDirs.push(permissionsDir);
    const { fake } = fakeRunLoop([
      { type: "tool-allowed", name: "bash" },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        permissionsDir,
      }),
    );

    expect(existsSync(permissionsPath(permissionsDir))).toBe(false);
    expect(logs.some((line) => line.includes("saved for"))).toBe(false);
  });

  test("the tool-allowed event escapes a control character in the tool name", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop([
      { type: "tool-allowed", name: "write\x1bfile" },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    const rendered = logs.join("\n");
    expect(rendered).toContain("write\\x1bfile");
    expect(rendered).not.toContain("write\x1bfile");
  });

  test("repeated-denials exits 1 and prints the /mode follow-up", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop([{ type: "done", reason: "repeated-denials" }]);

    const { code, logs } = await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(1);
    expect(logs.some((line) => line.includes("/mode"))).toBe(true);
  });

  test("no-tool-call with a denial and nothing executed exits 1", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop([
      { type: "permission-denied", name: "write_file", reason: "declined" },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { code } = await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(1);
  });

  test("no-tool-call with no tools and no denials still exits 0", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop();

    const { code } = await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(0);
  });

  test("a denial followed by a tool that executes still exits 0", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop([
      { type: "permission-denied", name: "write_file", reason: "declined" },
      { type: "tool-call", name: "bash", args: { command: "echo hi" } },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { code } = await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(0);
  });

  test("repeated-denials still exits 1 regardless of hadDenial/ranTool", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop([
      { type: "tool-call", name: "write_file", args: { path: "a.txt" } },
      { type: "permission-denied", name: "write_file", reason: "declined" },
      { type: "done", reason: "repeated-denials" },
    ]);

    const { code } = await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(1);
  });

  test("a read-only block does not count as a denial for the exit code", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop([
      { type: "permission-denied", name: "write_file", reason: "blocked" },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { code } = await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(0);
  });

  test("tool-allowed leaves no allowedTools field on the session file, and --continue seeds an empty allowlist", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake: firstRun } = fakeRunLoop([
      ...answeredTurn,
      { type: "tool-allowed", name: "bash" },
    ]);

    await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: firstRun,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    const createdId = listSessionIds(sessionsDir)[0]!;
    expect("allowedTools" in loadSession(createdId, sessionsDir)).toBe(false);

    const { fake: secondRun, capture } = fakeRunLoop();
    await captureLogs(() =>
      run(["--continue", "next"], {
        runLoop: secondRun,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(capture()?.allowedTools).toEqual([]);
  });

  const answeredTurn: LoopEvent[] = [
    { type: "messages-updated", messages: [{ role: "assistant", content: "ok" }] },
    { type: "done", reason: "no-tool-call" },
  ];

  test("records the resolved model on a new session and keeps a resumed session's own", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    // Node stores process.env.X = undefined as the string "undefined".
    const originalModel = process.env.SERI_MODEL;
    process.env.SERI_MODEL = "model-from-env";
    const asked: (string | undefined)[] = [];
    const deps = {
      runLoop: fakeRunLoop(answeredTurn).fake,
      loadAgentsFile: () => "",
      loadExtensions: () => ({
        skills: new Map(),
        rules: new Map(),
        hooks: { registry: new Map() },
      }),
      sessionsDir,
      getGroqModel: (id: string) => {
        asked.push(id);
        return getGroqModel("openai/gpt-oss-120b");
      },
    };

    try {
      const fresh = await captureLogs(() => run(["a", "task"], deps));
      expect(fresh.code).toBe(0);
      const created = loadSession(listSessionIds(sessionsDir)[0]!, sessionsDir);
      expect(created.model).toBe("model-from-env");
      expect(asked).toEqual(["model-from-env"]);

      const pinned: SessionState = {
        id: "pinned",
        cwd: ".",
        systemPrompt: "",
        permissionMode: "read-only",
        model: "model-on-session",
        messages: [],
      };
      saveSession(pinned, sessionsDir);
      const resumed = await captureLogs(() => run(["--resume", "pinned", "another", "task"], deps));
      expect(resumed.code).toBe(0);
      expect(asked.at(-1)).toBe("model-on-session");
      expect(loadSession("pinned", sessionsDir).model).toBe("model-on-session");
    } finally {
      restoreEnv("SERI_MODEL", originalModel);
    }
  });

  test("a resumed session is run with the rebuilt prompt, not the one frozen into its file", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const sessionCwd = mkdtempSync(join(tmpdir(), "seri-cli-test-cwd-"));
    extraTmpDirs.push(sessionCwd);
    const stale: SessionState = {
      id: "stale-prompt",
      cwd: sessionCwd,
      systemPrompt: "You are seri, a coding agent.",
      permissionMode: "read-only",
      model: "model-on-session",
      messages: [],
    };
    saveSession(stale, sessionsDir);

    const askedFor: string[] = [];
    const { fake, capture } = fakeRunLoop();
    const { code } = await captureLogs(() =>
      run(["--resume", "stale-prompt", "another", "task"], {
        runLoop: fake,
        loadAgentsFile: (dir: string) => {
          askedFor.push(dir);
          return "";
        },
        sessionsDir,
      }),
    );

    expect(code).toBe(0);
    expect(
      capture()?.system?.startsWith(
        buildSystemPrompt({ agentsContent: "", skills: [], rules: [] }),
      ),
    ).toBe(true);
    expect(capture()?.system).toContain("model-on-session");
    expect(askedFor).toEqual([sessionCwd]);
  });

  test("a brand-new session starts on the persisted model/provider, or the built-in default when none was picked", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const askedOpenRouter: string[] = [];
    const { code: firstCode } = await captureLogs(() =>
      run(["a", "task"], {
        runLoop: fakeRunLoop(answeredTurn).fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        getOpenRouterModel: (id: string) => {
          askedOpenRouter.push(id);
          return getGroqModel("openai/gpt-oss-120b");
        },
      }),
    );
    expect(firstCode).toBe(0);
    expect(askedOpenRouter).toEqual([]);
    const firstId = listSessionIds(sessionsDir)[0]!;
    const firstSession = loadSession(firstId, sessionsDir);
    expect(firstSession.model).toBe("openai/gpt-oss-120b");
    expect(firstSession.provider).toBeUndefined();
    expect(existsSync(join(tmpConfigRoot, ".seri", "config.json"))).toBe(false);

    setConfigValue("SERI_MODEL", "picked-model");
    setConfigValue("SERI_PROVIDER", "openrouter");

    const { code: secondCode } = await captureLogs(() =>
      run(["another", "task"], {
        runLoop: fakeRunLoop(answeredTurn).fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        getOpenRouterModel: (id: string) => {
          askedOpenRouter.push(id);
          return getGroqModel("openai/gpt-oss-120b");
        },
      }),
    );
    expect(secondCode).toBe(0);
    expect(askedOpenRouter).toEqual(["picked-model"]);
    const secondId = listSessionIds(sessionsDir).find((id) => id !== firstId);
    if (secondId === undefined) throw new Error("second session not found");
    const secondSession = loadSession(secondId, sessionsDir);
    expect(secondSession.model).toBe("picked-model");
    expect(secondSession.provider).toBe("openrouter");
  });

  test("a native provider (anthropic) dispatches through its own injected CliDeps fn", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const askedAnthropic: string[] = [];
    setConfigValue("SERI_MODEL", "claude-picked-model");
    setConfigValue("SERI_PROVIDER", "anthropic");

    const { code } = await captureLogs(() =>
      run(["a", "task"], {
        runLoop: fakeRunLoop(answeredTurn).fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        getAnthropicModel: (id: string) => {
          askedAnthropic.push(id);
          return getGroqModel("openai/gpt-oss-120b");
        },
      }),
    );

    expect(code).toBe(0);
    expect(askedAnthropic).toEqual(["claude-picked-model"]);
    const id = listSessionIds(sessionsDir)[0]!;
    const session = loadSession(id, sessionsDir);
    expect(session.model).toBe("claude-picked-model");
    expect(session.provider).toBe("anthropic");
  });

  test("a session saved without a model backfills one on resume and persists it", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const originalModel = process.env.SERI_MODEL;
    process.env.SERI_MODEL = "model-from-env";
    const asked: string[] = [];

    try {
      const legacyHeader = {
        id: "legacy",
        cwd: ".",
        systemPrompt: "",
        permissionMode: "read-only",
      };
      writeFileSync(join(sessionsDir, "legacy.jsonl"), `${JSON.stringify(legacyHeader)}\n`);
      expect("model" in loadSession("legacy", sessionsDir)).toBe(false);

      const { code } = await captureLogs(() =>
        run(["--resume", "legacy", "another", "task"], {
          runLoop: fakeRunLoop(answeredTurn).fake,
          loadAgentsFile: () => "",
          loadExtensions: () => ({
            skills: new Map(),
            rules: new Map(),
            hooks: { registry: new Map() },
          }),
          sessionsDir,
          getGroqModel: (id: string) => {
            asked.push(id);
            return getGroqModel("openai/gpt-oss-120b");
          },
        }),
      );

      expect(code).toBe(0);
      expect(asked).toEqual(["model-from-env"]);
      expect(loadSession("legacy", sessionsDir).model).toBe("model-from-env");
    } finally {
      restoreEnv("SERI_MODEL", originalModel);
    }
  });

  test("a session with no model backfills the persisted non-groq pair, not a mismatch", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const asked: string[] = [];

    setConfigValue("SERI_MODEL", "picked-model");
    setConfigValue("SERI_PROVIDER", "openrouter");

    const legacyHeader = {
      id: "legacy-no-provider",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
    };
    writeFileSync(
      join(sessionsDir, "legacy-no-provider.jsonl"),
      `${JSON.stringify(legacyHeader)}\n`,
    );

    const { code } = await captureLogs(() =>
      run(["--resume", "legacy-no-provider", "another", "task"], {
        runLoop: fakeRunLoop(answeredTurn).fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        getGroqModel: () => {
          throw new Error("should not be called: the persisted pair is openrouter, not groq");
        },
        getOpenRouterModel: (id: string) => {
          asked.push(id);
          return getGroqModel("openai/gpt-oss-120b");
        },
      }),
    );

    expect(code).toBe(0);
    expect(asked).toEqual(["picked-model"]);
    const resumed = loadSession("legacy-no-provider", sessionsDir);
    expect(resumed.model).toBe("picked-model");
    expect(resumed.provider).toBe("openrouter");
  });

  test("a model that never produced a turn is not recorded, so a corrected SERI_MODEL takes effect", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const originalModel = process.env.SERI_MODEL;
    process.env.SERI_MODEL = "openai/gpt-os-120b";
    const asked: string[] = [];
    const deps = (events: LoopEvent[]) => ({
      runLoop: fakeRunLoop(events).fake,
      loadAgentsFile: () => "",
      loadExtensions: () => ({
        skills: new Map(),
        rules: new Map(),
        hooks: { registry: new Map() },
      }),
      sessionsDir,
      getGroqModel: (id: string) => {
        asked.push(id);
        return getGroqModel("openai/gpt-oss-120b");
      },
    });

    try {
      await captureLogs(() =>
        run(["a", "task"], deps([{ type: "error", error: "model_not_found" }])),
      );
      const id = listSessionIds(sessionsDir)[0]!;
      expect(asked).toEqual(["openai/gpt-os-120b"]);
      expect("model" in loadSession(id, sessionsDir)).toBe(false);

      process.env.SERI_MODEL = "openai/gpt-oss-120b";
      const { code } = await captureLogs(() => run(["--resume", id, "again"], deps(answeredTurn)));
      expect(code).toBe(0);
      expect(asked.at(-1)).toBe("openai/gpt-oss-120b");
      expect(loadSession(id, sessionsDir).model).toBe("openai/gpt-oss-120b");
    } finally {
      restoreEnv("SERI_MODEL", originalModel);
    }
  });

  test("hands runLoop a live AbortSignal", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake, capture } = fakeRunLoop();

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      });
    } finally {
      console.log = originalLog;
    }

    expect(capture()?.signal).toBeInstanceOf(AbortSignal);
    expect(capture()?.signal?.aborted).toBe(false);
  });

  test("the approval prompt it gives runLoop resolves no on abort instead of hanging", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const answers: (ApprovalAnswer | undefined)[] = [];
    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      const parked = new AbortController();
      const pending = opts.approvalPrompt?.("write_file", { path: "a.txt" }, parked.signal);
      parked.abort();
      answers.push(await pending);

      answers.push(
        await opts.approvalPrompt?.("write_file", { path: "b.txt" }, AbortSignal.abort()),
      );
      yield { type: "done", reason: "aborted" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      });
    } finally {
      console.log = originalLog;
    }

    expect(answers).toEqual(["no", "no"]);
  }, 10_000);

  test("a real answer during the prompt is not swallowed by the close listener", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    let input: PassThrough | undefined;
    const answers: (ApprovalAnswer | undefined)[] = [];

    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      const pending = opts.approvalPrompt?.("write_file", { path: "a.txt" }, opts.signal);
      input?.write("y\n");
      answers.push(await pending);
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        createInterface: () => {
          input = new PassThrough();
          return createInterface({ input, output: new PassThrough() });
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(answers).toEqual(["once"]);
  }, 10_000);

  // Node EventEmitters do not replay past events to a late listener.
  test("stdin closing resolves no for every prompt, not just the first", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const input = new PassThrough();
    input.end();
    const answers: (ApprovalAnswer | "unsettled")[] = [];
    const unsettledAfter = (ms: number): Promise<"unsettled"> =>
      new Promise((r) => setTimeout(() => r("unsettled"), ms));

    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      const first = opts.approvalPrompt?.("write_file", { path: "a.txt" }, opts.signal);
      answers.push(
        (await Promise.race([first, unsettledAfter(2000)])) as ApprovalAnswer | "unsettled",
      );

      const second = opts.approvalPrompt?.("write_file", { path: "b.txt" }, opts.signal);
      answers.push(
        (await Promise.race([second, unsettledAfter(2000)])) as ApprovalAnswer | "unsettled",
      );

      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        createInterface: () => createInterface({ input, output: new PassThrough() }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(answers).toEqual(["no", "no"]);
  }, 10_000);

  // Node readline Ctrl-D closes the interface without ending the stream.
  test("closing the interface without ending the input does not latch every later prompt", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    let input: PassThrough | undefined;
    let rl: Interface | undefined;
    const answers: (ApprovalAnswer | undefined)[] = [];

    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      const first = opts.approvalPrompt?.("write_file", { path: "a.txt" }, opts.signal);
      rl?.close();
      answers.push(await first);

      const second = opts.approvalPrompt?.("write_file", { path: "b.txt" }, opts.signal);
      input?.write("y\n");
      answers.push(await second);

      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        createInterface: () => {
          input = new PassThrough();
          rl = createInterface({ input, output: new PassThrough() });
          return rl;
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(answers).toEqual(["no", "once"]);
  }, 10_000);

  test("a control character in the tool name is escaped before it reaches the terminal", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    let input: PassThrough | undefined;
    let rendered = "";

    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      const pending = opts.approvalPrompt?.("write\x1bfile", { path: "a.txt" }, opts.signal);
      input?.write("n\n");
      await pending;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        createInterface: () => {
          input = new PassThrough();
          const output = new PassThrough();
          output.on("data", (chunk: Buffer) => {
            rendered += chunk.toString();
          });
          return createInterface({ input, output });
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(rendered).toContain("write\\x1bfile");
    expect(rendered).not.toContain("write\x1bfile");
  }, 10_000);

  test("an MCP-shaped tool name offers [a]lways at the readline prompt; an unlisted built-in does not", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    let input: PassThrough | undefined;
    let rendered = "";

    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      const first = opts.approvalPrompt?.("mcp_exa_web_search", { query: "q" }, opts.signal);
      input?.write("n\n");
      await first;
      const second = opts.approvalPrompt?.("bash", { command: "ls" }, opts.signal);
      input?.write("n\n");
      await second;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        createInterface: () => {
          input = new PassThrough();
          const output = new PassThrough();
          output.on("data", (chunk: Buffer) => {
            rendered += chunk.toString();
          });
          return createInterface({ input, output });
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(rendered).toContain('Approve mcp_exa_web_search({"query":"q"})? [y]es / [a]lways');
    expect(rendered).toContain('Approve bash({"command":"ls"})? [y]es / [N]o');
  }, 10_000);

  test("a long write_file body is truncated on the approval prompt line", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    let input: PassThrough | undefined;
    let rendered = "";
    const longContent = "x".repeat(2000);

    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      const pending = opts.approvalPrompt?.(
        "write_file",
        { path: "a.txt", content: longContent },
        opts.signal,
      );
      input?.write("n\n");
      await pending;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        createInterface: () => {
          input = new PassThrough();
          const output = new PassThrough();
          output.on("data", (chunk: Buffer) => {
            rendered += chunk.toString();
          });
          return createInterface({ input, output });
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(rendered).not.toContain(longContent);
    expect(rendered).toContain("…");
  }, 10_000);

  // JSON.stringify(undefined) returns undefined, not a string.
  test("undefined args on the prompt do not throw", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    let input: PassThrough | undefined;
    let rendered = "";
    let threw = false;

    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      try {
        const pending = opts.approvalPrompt?.("write_file", undefined, opts.signal);
        input?.write("n\n");
        await pending;
      } catch {
        threw = true;
      }
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        createInterface: () => {
          input = new PassThrough();
          const output = new PassThrough();
          output.on("data", (chunk: Buffer) => {
            rendered += chunk.toString();
          });
          return createInterface({ input, output });
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(threw).toBe(false);
    expect(rendered).toContain("undefined");
  }, 10_000);

  test("the prompt does not offer always for bash, and typing a resolves no", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    let input: PassThrough | undefined;
    let rendered = "";
    const answers: (ApprovalAnswer | undefined)[] = [];

    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      const pending = opts.approvalPrompt?.("bash", { command: "ls -la" }, opts.signal);
      input?.write("a\n");
      answers.push(await pending);
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        createInterface: () => {
          input = new PassThrough();
          const output = new PassThrough();
          output.on("data", (chunk: Buffer) => {
            rendered += chunk.toString();
          });
          return createInterface({ input, output });
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(rendered).not.toContain("[a]lways");
    expect(rendered).toContain("[y]es / [N]o");
    expect(answers).toEqual(["no"]);
  }, 10_000);

  test("chooseInterfaceOutput picks whichever of stderr/stdout is still a terminal", () => {
    const originalStderrTTY = process.stderr.isTTY;
    const originalStdoutTTY = process.stdout.isTTY;
    try {
      process.stderr.isTTY = true;
      process.stdout.isTTY = false;
      expect(chooseInterfaceOutput()).toBe(process.stderr);

      process.stderr.isTTY = false;
      process.stdout.isTTY = true;
      expect(chooseInterfaceOutput()).toBe(process.stdout);

      process.stderr.isTTY = false;
      process.stdout.isTTY = false;
      expect(chooseInterfaceOutput()).toBe(process.stderr);
    } finally {
      process.stderr.isTTY = originalStderrTTY;
      process.stdout.isTTY = originalStdoutTTY;
    }
  });

  // Node readline in raw mode eats 0x03 and does not raise SIGINT.
  test("a SIGINT on the readline interface cancels through signals.ts instead of denying", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    let rl: Interface | undefined;

    let answer: ApprovalAnswer | "unsettled" | undefined;
    let cancelledBy: NodeJS.Signals | undefined;
    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      const parked = new AbortController();
      const unregister = onSignalCancel((signal) => {
        cancelledBy = signal;
        parked.abort();
      });
      try {
        const pending = opts.approvalPrompt?.("write_file", { path: "a.txt" }, parked.signal);
        rl?.emit("SIGINT");
        answer = await Promise.race([
          pending,
          new Promise<"unsettled">((r) => setTimeout(() => r("unsettled"), 1000)),
        ]);
      } finally {
        unregister();
        rl?.close();
      }
      yield { type: "done", reason: "aborted" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await run(["write", "hello.txt"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        createInterface: () => {
          rl = createInterface({ input: new PassThrough(), output: new PassThrough() });
          return rl;
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(cancelledBy).toBe("SIGINT");
    expect(answer).toBe("no");
    expect(code).toBe(1);
  }, 10_000);

  test("an edit result is reported as text returned, not as a file written", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      { type: "tool-result", name: "edit", result: "edited text" },
      { type: "tool-result", name: "write_file", result: "ok" },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["edit", "a.txt"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(logs.join("\n")).toContain("nothing written");
    expect(logs.join("\n")).toContain("✓ write_file done");
  });

  test("a write_file result carrying diagnostics says how many were fed back", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      {
        type: "tool-result",
        name: "write_file",
        result: {
          written: true,
          verification: {
            status: "diagnostics",
            command: "tsc --noEmit",
            elapsedMs: 3600,
            diagnostics: [{ file: "a.ts", line: 1, column: 1, message: "error TS2322: nope" }],
            truncated: false,
            inWrittenFile: 1,
            total: 1,
          } satisfies CheckOutcome,
        },
      },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["write", "a.ts"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(logs.join("\n")).toContain("✓ write_file done (1 diagnostic");
  });

  test("a capped diagnostic list shows the true total, not the capped length", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      {
        type: "tool-result",
        name: "write_file",
        result: {
          written: true,
          verification: {
            status: "diagnostics",
            command: "tsc --noEmit",
            elapsedMs: 3600,
            diagnostics: Array.from({ length: 20 }, () => ({
              file: "a.ts",
              line: 1,
              column: 1,
              message: "error TS2322: nope",
            })),
            truncated: false,
            inWrittenFile: 1,
            total: 300,
          } satisfies CheckOutcome,
        },
      },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["write", "a.ts"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(logs.join("\n")).toContain("20 of 300 diagnostics");
  });

  test("a failed check is surfaced instead of printing a bare green checkmark", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      {
        type: "tool-result",
        name: "write_file",
        result: {
          written: true,
          verification: {
            status: "failed",
            reason: "bun run typechek could not be run: script not found",
          } satisfies CheckOutcome,
        },
      },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["write", "a.ts"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    const printed = logs.join("\n");
    expect(printed).toContain("check failed");
    expect(printed).toContain("typechek");
  });

  test("a clean check reports what it cost", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      {
        type: "tool-result",
        name: "write_file",
        result: {
          written: true,
          verification: {
            status: "ok",
            command: "tsc --noEmit",
            elapsedMs: 3600,
          } satisfies CheckOutcome,
        },
      },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["write", "a.ts"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(logs.join("\n")).toContain("3.6s");
  });

  test("a retry is announced with its attempt number instead of looking like a hung turn", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      { type: "retry", attempt: 1 },
      { type: "retry", attempt: 2 },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["say", "hi"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(logs.filter((line) => line.includes("retrying"))).toEqual([
      "\n↻ rate-limited or unavailable; retrying (attempt 1)",
      "\n↻ rate-limited or unavailable; retrying (attempt 2)",
    ]);
  });

  function usageEvent(
    inputTokens: number | undefined,
    outputTokens: number | undefined,
    cost?: CostReport,
  ): LoopEvent {
    return {
      type: "usage",
      usage: {
        inputTokens,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      },
      cost,
    };
  }

  test("sums the run's usage events into one end-of-run summary line", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      usageEvent(120, 30),
      usageEvent(200, 45),
      { type: "done", reason: "no-tool-call" },
    ]);

    const { code, logs } = await captureLogs(() =>
      run(["say", "hi"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(0);
    expect(logs.filter((line) => line.includes("tokens:"))).toEqual(["\n(tokens: 320 in, 75 out)"]);
  });

  test("prints only the half a provider reported when it reported one and not the other", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      usageEvent(320, undefined),
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["say", "hi"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(logs.filter((line) => line.includes("tokens:"))).toEqual(["\n(tokens: 320 in)"]);
  });

  test("prints a reported zero, which is a measurement rather than a missing field", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([usageEvent(320, 0), { type: "done", reason: "no-tool-call" }]);

    const { logs } = await captureLogs(() =>
      run(["say", "hi"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(logs.filter((line) => line.includes("tokens:"))).toEqual(["\n(tokens: 320 in, 0 out)"]);
  });

  test("prints no token summary for a run that reported no usage", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop();

    const { logs } = await captureLogs(() =>
      run(["say", "hi"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(logs.filter((line) => line.includes("tokens:"))).toEqual([]);
  });

  test("still prints the summary for a run that ended in an error", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      usageEvent(120, 30),
      { type: "error", error: "AI_APICallError: Invalid API Key" },
    ]);

    const { code, logs } = await captureLogs(() =>
      run(["say", "hi"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(1);
    expect(logs.filter((line) => line.includes("tokens:"))).toEqual(["\n(tokens: 120 in, 30 out)"]);
  });

  test("passes provider, modelId and catalog to runLoop so it can compute a cost", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake, capture } = fakeRunLoop();
    await run(["say", "hi"], {
      runLoop: fake,
      loadAgentsFile: () => "",
      loadExtensions: () => ({
        skills: new Map(),
        rules: new Map(),
        hooks: { registry: new Map() },
      }),
      sessionsDir,
    });

    const opts = capture();
    expect(opts?.provider).toBe("groq");
    expect(opts?.modelId).toBeDefined();
    expect(opts?.catalog).toBeDefined();
  });

  test("prints the run's cost alongside its token summary", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      usageEvent(120, 30, {
        amountUsd: 0.0021,
        status: "estimated",
        source: "provider_models_api",
      }),
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["say", "hi"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(logs.filter((line) => line.includes("cost:"))).toEqual(["(cost: ~$0.0021 (estimated))"]);
  });

  async function captureStdout(
    invoke: () => Promise<number>,
  ): Promise<{ code: number; stdout: string }> {
    let stdout = "";
    const originalLog = console.log;
    const originalWrite = process.stdout.write;
    const originalError = console.error;
    console.log = (msg: string) => {
      stdout += `${String(msg)}\n`;
    };
    process.stdout.write = ((chunk: string) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    console.error = () => {};
    try {
      return { code: await invoke(), stdout };
    } finally {
      console.log = originalLog;
      process.stdout.write = originalWrite;
      console.error = originalError;
    }
  }

  test("the token summary starts on its own line when a mid-stream failure left stdout mid-line", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      { type: "text-delta", text: "partial answer" },
      usageEvent(900, 7),
      { type: "error", error: "AI_APICallError: upstream connection reset" },
    ]);

    const { code, stdout } = await captureStdout(() =>
      run(["say", "hi"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(1);
    expect(stdout).toContain("partial answer\n(tokens: 900 in, 7 out)\n");
  });

  test("a run that ends without a done event exits non-zero", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([{ type: "error", error: "AI_APICallError: Invalid API Key" }]);

    const { code } = await captureLogs(() =>
      run(["say", "hi"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(1);
  });

  test("a run that stopped at max-iterations exits non-zero", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([{ type: "done", reason: "max-iterations" }]);

    const { code } = await captureLogs(() =>
      run(["say", "hi"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(1);
  });

  test("a run that recovered from a tool error still exits 0", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      { type: "error", error: 'Tool "read_file" threw during execution: Error: ENOENT' },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { code } = await captureLogs(() =>
      run(["say", "hi"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    expect(code).toBe(0);
  });

  test("`config set` is a task, not an argv verb", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();

    const { code } = await captureLogs(() =>
      run(["config", "set", "GROQ_API_KEY", "gsk_live_secret"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        authConfigDir: tmpConfigRoot,
      }),
    );

    expect(code).toBe(0);
    expect(capture()?.messages.at(-1)).toEqual({
      role: "user",
      content: "config set GROQ_API_KEY gsk_live_secret",
    });
  });

  test.each(["toString", "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"])(
    "a task starting with %p is sent to the model, not dispatched as a slash command",
    async (word) => {
      process.env.GROQ_API_KEY = "fake-test-key";
      const existing: SessionState = {
        id: "proto",
        cwd: ".",
        systemPrompt: "",
        permissionMode: "read-only",
        messages: [],
      };
      saveSession(existing, sessionsDir);

      const { fake, capture } = fakeRunLoop();

      const originalLog = console.log;
      console.log = () => {};
      let code: number;
      try {
        code = await run([word, "is", "wrong", "on", "User"], {
          runLoop: fake,
          loadAgentsFile: () => "",
          loadExtensions: () => ({
            skills: new Map(),
            rules: new Map(),
            hooks: { registry: new Map() },
          }),
          sessionsDir,
        });
      } finally {
        console.log = originalLog;
      }

      expect(code).toBe(0);
      expect(capture()?.messages.at(-1)).toEqual({
        role: "user",
        content: `${word} is wrong on User`,
      });
    },
  );

  test("a task starting with /exit is sent to the model, not treated as a quit command", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();

    const code = await run(["/exit", "the", "debugger", "and", "retry"], {
      runLoop: fake,
      loadAgentsFile: () => "",
      loadExtensions: () => ({
        skills: new Map(),
        rules: new Map(),
        hooks: { registry: new Map() },
      }),
      sessionsDir,
    });

    expect(code).toBe(0);
    expect(capture()?.messages.at(-1)).toEqual({
      role: "user",
      content: "/exit the debugger and retry",
    });
  });

  test("a bare /exit with no session is sent to the model, not treated as a quit command", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();

    const code = await run(["/exit"], {
      runLoop: fake,
      loadAgentsFile: () => "",
      loadExtensions: () => ({
        skills: new Map(),
        rules: new Map(),
        hooks: { registry: new Map() },
      }),
      sessionsDir,
    });

    expect(code).toBe(0);
    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "/exit" });
  });

  function latestSessionId(): string {
    const id = listSessionIds(sessionsDir)[0];
    if (id === undefined) throw new Error("no session");
    return id;
  }

  function trajectoryLines(sessionId: string): unknown[] {
    return readTrajectory(join(getTrajectoriesDir(getConfigDir()), `${sessionId}.jsonl`));
  }

  function trajectoryKinds(sessionId: string): string[] {
    return trajectoryLines(sessionId).map((line) => (line as { kind: string }).kind);
  }

  test("an injected turn writes header, summarized tool_result, usage, and done", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const cost: CostReport = {
      amountUsd: 0.001,
      status: "estimated",
      source: "provider_models_api",
    };
    const { fake } = fakeRunLoop([
      { type: "tool-call", name: "read_file", args: { path: "a.ts" } },
      { type: "tool-result", name: "read_file", result: "hello" },
      usageEvent(10, 4, cost),
      { type: "done", reason: "no-tool-call" },
    ]);

    await captureLogs(() =>
      run(["read", "a.ts"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    const sessionId = latestSessionId();
    expect(trajectoryKinds(sessionId)).toEqual([
      "header",
      "tool_call",
      "tool_result",
      "usage",
      "done",
    ]);
    const resultLine = trajectoryLines(sessionId).find(
      (line) => (line as { kind?: string }).kind === "tool_result",
    ) as { result: unknown };
    expect(resultLine.result).toEqual({ bytes: 5 });
  });

  test("SERI_TRAJECTORY_ENABLED=false creates no trajectories directory", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const original = process.env.SERI_TRAJECTORY_ENABLED;
    process.env.SERI_TRAJECTORY_ENABLED = "false";
    const { fake } = fakeRunLoop();
    try {
      await captureLogs(() =>
        run(["do", "a", "task"], {
          runLoop: fake,
          loadAgentsFile: () => "",
          loadExtensions: () => ({
            skills: new Map(),
            rules: new Map(),
            hooks: { registry: new Map() },
          }),
          sessionsDir,
        }),
      );
      expect(existsSync(getTrajectoriesDir(getConfigDir()))).toBe(false);
    } finally {
      restoreEnv("SERI_TRAJECTORY_ENABLED", original);
    }
  });

  test("`/trajectory off` via argv without a key does not persist via the slash handler", async () => {
    const original = process.env.SERI_TRAJECTORY_ENABLED;
    const originalKey = process.env.GROQ_API_KEY;
    delete process.env.SERI_TRAJECTORY_ENABLED;
    delete process.env.GROQ_API_KEY;
    try {
      const { code, logs } = await captureLogs(() => run(["/trajectory", "off"], { sessionsDir }));
      expect(code).not.toBe(0);
      expect(logs).not.toContain("Trajectory recording is off.");
      expect(loadConfig(getConfigDir()).SERI_TRAJECTORY_ENABLED).toBeUndefined();
      expect(listSessionIds(sessionsDir)).toEqual([]);
    } finally {
      restoreEnv("SERI_TRAJECTORY_ENABLED", original);
      restoreEnv("GROQ_API_KEY", originalKey);
    }
  });

  test("`/trajectory off` via argv with a fake loop is a task", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const original = process.env.SERI_TRAJECTORY_ENABLED;
    delete process.env.SERI_TRAJECTORY_ENABLED;
    const { fake, capture } = fakeRunLoop();
    try {
      const { code, logs } = await captureLogs(() =>
        run(["/trajectory", "off"], {
          runLoop: fake,
          loadAgentsFile: () => "",
          loadExtensions: () => ({
            skills: new Map(),
            rules: new Map(),
            hooks: { registry: new Map() },
          }),
          sessionsDir,
        }),
      );
      expect(code).toBe(0);
      expect(logs).not.toContain("Trajectory recording is off.");
      expect(loadConfig(getConfigDir()).SERI_TRAJECTORY_ENABLED).toBeUndefined();
      expect(capture()?.messages.at(-1)).toEqual({
        role: "user",
        content: "/trajectory off",
      });
    } finally {
      restoreEnv("SERI_TRAJECTORY_ENABLED", original);
    }
  });

  test("SLASH_COMMANDS /trajectory off still persists", async () => {
    const original = process.env.SERI_TRAJECTORY_ENABLED;
    delete process.env.SERI_TRAJECTORY_ENABLED;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await invokeSlash("/trajectory", ["off"], {
        sessionsDir,
        checkpointsDir: join(tmpConfigRoot, "checkpoints"),
        configDir: getConfigDir(),
      });
      expect(logs).toContain("Trajectory recording is off.");
      expect(loadConfig(getConfigDir()).SERI_TRAJECTORY_ENABLED).toBe("false");
    } finally {
      console.log = originalLog;
      restoreEnv("SERI_TRAJECTORY_ENABLED", original);
    }
  });

  test("an injected near-miss edit error writes edit_outcome near_miss", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop([
      {
        type: "error",
        error: "Could not find the specified text to replace in a.ts",
      },
      { type: "done", reason: "no-tool-call" },
    ]);

    await captureLogs(() =>
      run(["edit", "a.ts"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    const outcome = trajectoryLines(latestSessionId()).find(
      (line) => (line as { kind?: string }).kind === "edit_outcome",
    ) as { status: string };
    expect(outcome.status).toBe("near_miss");
  });

  test("done reason aborted is recorded", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake } = fakeRunLoop([{ type: "done", reason: "aborted" }]);

    await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    const done = trajectoryLines(latestSessionId()).find(
      (line) => (line as { kind?: string }).kind === "done",
    ) as { reason: string };
    expect(done.reason).toBe("aborted");
  });

  test("child token spend is recorded as usage source child", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const childCost: CostReport = {
      amountUsd: 0.002,
      status: "estimated",
      source: "provider_models_api",
    };
    async function* fake(opts: RunLoopOpts) {
      const dispatch = opts.tools[DISPATCH_TOOL_NAME];
      if (dispatch?.execute !== undefined) {
        await dispatch.execute(
          { tasks: [{ role: "explore" as const, goal: "look around" }] },
          { toolCallId: "t1", messages: opts.messages, context: {}, abortSignal: opts.signal },
        );
        yield { type: "done" as const, reason: "no-tool-call" as const };
        return opts.messages;
      }
      yield usageEvent(7, 3, childCost);
      yield { type: "done" as const, reason: "no-tool-call" as const };
      return opts.messages;
    }

    await captureLogs(() =>
      run(["dispatch"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    const childUsage = trajectoryLines(latestSessionId()).find(
      (line) =>
        (line as { kind?: string; source?: string }).kind === "usage" &&
        (line as { source?: string }).source === "child",
    ) as { source: string; usage: { inputTokens?: number } } | undefined;
    expect(childUsage?.source).toBe("child");
    expect(childUsage?.usage.inputTokens).toBe(7);
  });
});

describe("bare seri", () => {
  const originalKey = process.env.GROQ_API_KEY;
  const originalHome = process.env.HOME;
  let sessionsDir: string;
  let tmpConfigRoot: string;

  function restoreEnv(key: string, original: string | undefined): void {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }

  async function captureLogs(
    invoke: () => Promise<number>,
  ): Promise<{ code: number; logs: string[]; errors: string[] }> {
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg: string) => logs.push(String(msg));
    console.error = (msg: string) => errors.push(String(msg));
    try {
      return { code: await invoke(), logs, errors };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  async function* echoRunLoop(
    opts: RunLoopOpts,
  ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
    yield { type: "messages-updated", messages: opts.messages };
    yield { type: "done", reason: "no-tool-call" };
    return opts.messages;
  }

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-bare-sessions-"));
    tmpConfigRoot = mkdtempSync(join(tmpdir(), "seri-cli-test-bare-config-"));
    process.env.HOME = tmpConfigRoot;
    resetCatalogCache();
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
  });

  afterEach(() => {
    restoreEnv("GROQ_API_KEY", originalKey);
    restoreEnv("HOME", originalHome);
    resetCatalogCache();
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(tmpConfigRoot, { recursive: true, force: true });
  });

  test("`run([], {})` with no isTTY prints USAGE and returns 0, unchanged", async () => {
    const { code, logs } = await captureLogs(() => run([], {}));

    expect(code).toBe(0);
    expect(logs).toContain(USAGE);
  });

  test('`run(["--max-turns", "5"], {})` with no isTTY is still a usage error', async () => {
    const { code, errors } = await captureLogs(() => run(["--max-turns", "5"], {}));

    expect(code).toBe(2);
    expect(errors.some((line) => line.includes("No task given."))).toBe(true);
  });

  test('`run(["   "], {})` with no isTTY is a usage error, not a persisted empty-content message', async () => {
    const { code, errors } = await captureLogs(() => run(["   "], { sessionsDir }));

    expect(code).toBe(2);
    expect(errors.some((line) => line.includes("No task given."))).toBe(true);
    expect(listSessionIds(sessionsDir)).toHaveLength(0);
  });

  test('`run([""], {})` with no isTTY is a usage error, not a persisted empty-content message', async () => {
    const { code, errors } = await captureLogs(() => run([""], { sessionsDir }));

    expect(code).toBe(2);
    expect(errors.some((line) => line.includes("No task given."))).toBe(true);
    expect(listSessionIds(sessionsDir)).toHaveLength(0);
  });

  test('runStart narrowing: `--continue "new task"` appends it, `--continue` alone appends nothing', async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const existing: SessionState = {
      id: "abc",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [{ role: "user", content: "old task" }],
    };
    saveSession(existing, sessionsDir);

    await captureLogs(() =>
      run(["--continue", "new", "task"], {
        runLoop: echoRunLoop,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );
    expect(loadSession("abc", sessionsDir).messages).toEqual([
      { role: "user", content: "old task" },
      { role: "user", content: "new task" },
    ]);

    await captureLogs(() =>
      run(["--continue"], {
        runLoop: echoRunLoop,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );
    expect(loadSession("abc", sessionsDir).messages).toEqual([
      { role: "user", content: "old task" },
      { role: "user", content: "new task" },
    ]);
  });

  test("`--resume <id>` with no task appends no empty-content user message", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const existing: SessionState = {
      id: "abc",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [{ role: "user", content: "old task" }],
    };
    saveSession(existing, sessionsDir);

    await captureLogs(() =>
      run(["--resume", "abc"], {
        runLoop: echoRunLoop,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
      }),
    );

    const messages = loadSession("abc", sessionsDir).messages;
    expect(messages).not.toContainEqual({ role: "user", content: "" });
    expect(messages).toEqual([{ role: "user", content: "old task" }]);
  });
});

describe("guided setup gate", () => {
  let configDir: string;
  const originalEnv: Partial<Record<string, string>> = {};

  function restoreEnv(key: string, original: string | undefined): void {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "seri-cli-test-setup-gate-"));
    for (const keyName of Object.values(PROVIDER_API_KEY_NAMES)) {
      originalEnv[keyName] = process.env[keyName];
      delete process.env[keyName];
    }
  });

  afterEach(() => {
    for (const [keyName, original] of Object.entries(originalEnv)) restoreEnv(keyName, original);
    rmSync(configDir, { recursive: true, force: true });
  });

  test("zero keys configured anywhere: configuredProviders(dir).size === 0 is true", () => {
    expect(configuredProviders(configDir).size === 0).toBe(true);
  });

  test("one key configured via config.json: configuredProviders(dir).size === 0 is false", () => {
    setConfigValue("GROQ_API_KEY", "fake-test-key", configDir);
    expect(configuredProviders(configDir).size === 0).toBe(false);
  });

  test("one key configured via env var: configuredProviders(dir).size === 0 is false", () => {
    process.env.OPENROUTER_API_KEY = "fake-test-key";
    expect(configuredProviders(configDir).size === 0).toBe(false);
  });

  test("an ignored seri plan with zero keys still needs guided setup", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      saveAuthSession(
        {
          accessToken: "at-1",
          refreshToken: "rt-1",
          userId: "user_1",
          email: "a@example.com",
          obtainedAt: "2026-01-01T00:00:00.000Z",
        },
        configDir,
      );
      expect(needsGuidedSetup(configDir)).toBe(false);
      ignoreSeriPlan(configDir);
      expect(needsGuidedSetup(configDir)).toBe(true);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("a hosted login with zero keys does not need guided setup", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      expect(needsGuidedSetup(configDir)).toBe(true);
      saveAuthSession(
        {
          accessToken: "at-1",
          refreshToken: "rt-1",
          userId: "user_1",
          email: "a@example.com",
          obtainedAt: "2026-01-01T00:00:00.000Z",
        },
        configDir,
      );
      expect(needsGuidedSetup(configDir)).toBe(false);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("a corrupted auth.json is still a blank first run", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      writeFileSync(join(configDir, AUTH_FILENAME), "{not valid json");
      expect(needsGuidedSetup(configDir)).toBe(true);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("a ChatGPT plan with no persisted default still needs guided setup", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      saveCodexSubscription(
        {
          accessToken: "at-codex",
          refreshToken: "rt-codex",
          obtainedAt: "2026-01-01T00:00:00.000Z",
          accountId: "acct-codex",
        },
        configDir,
      );
      expect(needsGuidedSetup(configDir)).toBe(true);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("a ChatGPT plan plus a persisted openai default does not need guided setup", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      saveCodexSubscription(
        {
          accessToken: "at-codex",
          refreshToken: "rt-codex",
          obtainedAt: "2026-01-01T00:00:00.000Z",
          accountId: "acct-codex",
        },
        configDir,
      );
      persistDefaultModel({ model: "gpt-5", provider: "openai" }, configDir);
      expect(needsGuidedSetup(configDir)).toBe(false);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("an anthropic key with no persisted default still needs guided setup", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      setConfigValue("ANTHROPIC_API_KEY", "sk-ant-test", configDir);
      expect(needsGuidedSetup(configDir)).toBe(true);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("a groq key with no persisted default does not need guided setup", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      setConfigValue("GROQ_API_KEY", "gsk-test", configDir);
      expect(needsGuidedSetup(configDir)).toBe(false);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("an openrouter key with no persisted default does not need guided setup", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      setConfigValue("OPENROUTER_API_KEY", "sk-or-test", configDir);
      expect(needsGuidedSetup(configDir)).toBe(false);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("a leftover Codex CLI login with no persisted default still needs guided setup", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), "seri-cli-test-codex-leftover-"));
    process.env.CODEX_HOME = codexHome;
    try {
      writeFileSync(
        join(codexHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: "tok", refresh_token: "rt", account_id: "acct" },
        }),
      );
      expect(needsGuidedSetup(configDir)).toBe(true);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("an ignored leftover Codex CLI login is a blank first run", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), "seri-cli-test-codex-ignored-"));
    process.env.CODEX_HOME = codexHome;
    try {
      writeFileSync(
        join(codexHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: "tok", refresh_token: "rt", account_id: "acct" },
        }),
      );
      ignoreCodexSubscription(configDir);
      expect(needsGuidedSetup(configDir)).toBe(true);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("a Grok plan with no persisted default still needs guided setup", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      saveXaiSubscription(
        {
          accessToken: "at-grok",
          refreshToken: "rt-grok",
          obtainedAt: "2026-01-01T00:00:00.000Z",
        },
        configDir,
      );
      expect(needsGuidedSetup(configDir)).toBe(true);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("a Grok plan plus a persisted xai default does not need guided setup", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      saveXaiSubscription(
        {
          accessToken: "at-grok",
          refreshToken: "rt-grok",
          obtainedAt: "2026-01-01T00:00:00.000Z",
        },
        configDir,
      );
      persistDefaultModel({ model: "grok-4", provider: "xai" }, configDir);
      expect(needsGuidedSetup(configDir)).toBe(false);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("a ChatGPT plan plus a persisted groq default still needs guided setup", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      saveCodexSubscription(
        {
          accessToken: "at-codex",
          refreshToken: "rt-codex",
          obtainedAt: "2026-01-01T00:00:00.000Z",
          accountId: "acct-codex",
        },
        configDir,
      );
      persistDefaultModel({ model: "openai/gpt-oss-120b", provider: "groq" }, configDir);
      expect(needsGuidedSetup(configDir)).toBe(true);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test.each([
    ["GOOGLE_GENERATIVE_AI_API_KEY", "gk-test"],
    ["OPENAI_API_KEY", "sk-test"],
    ["XAI_API_KEY", "xai-test"],
  ] as const)("%s with no persisted default still needs guided setup", (keyName, value) => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = configDir;
    try {
      setConfigValue(keyName, value, configDir);
      expect(needsGuidedSetup(configDir)).toBe(true);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("a Codex-shaped auth.json is still a blank first run", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), "seri-cli-test-codex-home-"));
    process.env.CODEX_HOME = codexHome;
    try {
      writeFileSync(
        join(configDir, AUTH_FILENAME),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: "tok", account_id: "acct" },
        }),
      );
      expect(needsGuidedSetup(configDir)).toBe(true);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe("run (permanent permissions)", () => {
  const originalKey = process.env.GROQ_API_KEY;
  const originalHome = process.env.HOME;
  let sessionsDir: string;
  let permissionsDir: string;
  let tmpConfigRoot: string;
  const key = projectKey(projectRoot(process.cwd()));

  function restoreEnv(key: string, original: string | undefined): void {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }

  async function captureLogs(
    invoke: () => Promise<number>,
  ): Promise<{ code: number; logs: string[] }> {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg: string) => logs.push(String(msg));
    console.error = (msg: string) => logs.push(String(msg));
    try {
      return { code: await invoke(), logs };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  beforeEach(() => {
    process.env.GROQ_API_KEY = "fake-test-key";
    sessionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-permissions-sessions-"));
    permissionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-permissions-dir-"));
    tmpConfigRoot = mkdtempSync(join(tmpdir(), "seri-cli-test-permissions-config-"));
    process.env.HOME = tmpConfigRoot;
  });

  afterEach(() => {
    restoreEnv("GROQ_API_KEY", originalKey);
    restoreEnv("HOME", originalHome);
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(permissionsDir, { recursive: true, force: true });
    rmSync(tmpConfigRoot, { recursive: true, force: true });
  });

  test("a stored grant reaches runLoop as the allowedTools seed", async () => {
    writeFileSync(
      permissionsPath(permissionsDir),
      `global: []\nprojects:\n  '${key}':\n    - write_file\n`,
    );
    const { fake, capture } = fakeRunLoop();

    await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        permissionsDir,
      }),
    );

    expect(capture()?.allowedTools).toContain("write_file");
  });

  test("a tool-allowed event for write_file persists the grant and prints where it was saved", async () => {
    const { fake } = fakeRunLoop([
      { type: "tool-allowed", name: "write_file" },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        permissionsDir,
      }),
    );

    expect(loadGrants(permissionsDir, projectRoot(process.cwd())).project).toContain("write_file");
    expect(logs.some((line) => line.includes("saved for"))).toBe(true);
  });

  test("a grant made in one run is seeded into the next", async () => {
    const { fake: firstRun } = fakeRunLoop([
      { type: "tool-allowed", name: "write_file" },
      { type: "done", reason: "no-tool-call" },
    ]);
    await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: firstRun,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        permissionsDir,
      }),
    );

    const { fake: secondRun, capture } = fakeRunLoop();
    await captureLogs(() =>
      run(["--continue"], {
        runLoop: secondRun,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        permissionsDir,
      }),
    );

    expect(capture()?.allowedTools).toContain("write_file");
  });

  test("the pre-approved line prints only in approve-each", async () => {
    writeFileSync(
      permissionsPath(permissionsDir),
      `global: []\nprojects:\n  '${key}':\n    - write_file\n`,
    );

    const { fake: approveEachFake } = fakeRunLoop();
    const { logs: approveEachLogs } = await captureLogs(() =>
      run(["do", "a", "task"], {
        runLoop: approveEachFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        permissionsDir,
      }),
    );
    expect(
      approveEachLogs.some((line) => line.includes("Pre-approved without asking: write_file")),
    ).toBe(true);

    const readOnlySession: SessionState = {
      id: "ro",
      cwd: process.cwd(),
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [],
    };
    saveSession(readOnlySession, sessionsDir);
    const { fake: readOnlyFake } = fakeRunLoop();
    const { logs: readOnlyLogs } = await captureLogs(() =>
      run(["--resume", "ro", "do", "a", "task"], {
        runLoop: readOnlyFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        permissionsDir,
      }),
    );
    expect(readOnlyLogs.some((line) => line.includes("Pre-approved without asking"))).toBe(false);

    const { fake: autoFake } = fakeRunLoop();
    const { logs: autoLogs } = await captureLogs(() =>
      run(["--dangerously-skip-permissions", "do", "a", "task"], {
        runLoop: autoFake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
        sessionsDir,
        permissionsDir,
      }),
    );
    expect(autoLogs.some((line) => line.includes("Pre-approved without asking"))).toBe(false);
  });

  // Windows chmod cannot force this store-write failure; skipIf win32.
  test.skipIf(process.platform === "win32")(
    "a store write failure warns instead of killing the run",
    async () => {
      rmSync(permissionsDir, { recursive: true, force: true });
      writeFileSync(permissionsDir, "not a directory");
      const { fake } = fakeRunLoop([
        { type: "tool-allowed", name: "write_file" },
        { type: "done", reason: "no-tool-call" },
      ]);

      const { code, logs } = await captureLogs(() =>
        run(["do", "a", "task"], {
          runLoop: fake,
          loadAgentsFile: () => "",
          loadExtensions: () => ({
            skills: new Map(),
            rules: new Map(),
            hooks: { registry: new Map() },
          }),
          sessionsDir,
          permissionsDir,
        }),
      );

      expect(code).toBe(0);
      expect(
        logs.some((line) => line.includes("could not save the permanent approval for write_file")),
      ).toBe(true);
    },
  );
});

describe("run (/mode)", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-mode-sessions-"));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  test("`/mode` via argv is a task and does not cycle the mode", async () => {
    const originalKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "fake-test-key";
    const existing: SessionState = {
      id: "def",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [],
    };
    saveSession(existing, sessionsDir);

    const { fake, capture } = fakeRunLoop();
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await run(["/mode"], {
        sessionsDir,
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
      });
      expect(code).toBe(0);
    } finally {
      console.log = originalLog;
      if (originalKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalKey;
    }

    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "/mode" });
    expect(listSessionIds(sessionsDir).length).toBeGreaterThanOrEqual(1);
    expect(loadSession("def", sessionsDir).permissionMode).toBe("read-only");
  });

  test("`/mode` via SLASH_COMMANDS still cycles", async () => {
    const existing: SessionState = {
      id: "def",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [],
    };
    saveSession(existing, sessionsDir);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await invokeSlash(
        "/mode",
        [],
        { sessionsDir, checkpointsDir: join(sessionsDir, "ck"), configDir: getConfigDir() },
        loadSession("def", sessionsDir),
      );
    } finally {
      console.log = originalLog;
    }
    expect(loadSession("def", sessionsDir).permissionMode).toBe("approve-each");
  });

  test("`--resume /mode` is a usage error naming --continue, not a session-not-found lookup", async () => {
    const existing: SessionState = {
      id: "abc",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [],
    };
    saveSession(existing, sessionsDir);

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    let code: number;
    try {
      code = await run(["--resume", "/mode"], { sessionsDir });
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("--continue");
    expect(loadSession("abc", sessionsDir).permissionMode).toBe("read-only");
  });

  test("`/mode is broken, fix it` stays a task and does not cycle the mode", async () => {
    const originalKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "fake-test-key";
    const existing: SessionState = {
      id: "ghi",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [],
    };
    saveSession(existing, sessionsDir);

    const { fake, capture } = fakeRunLoop();

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["/mode", "is", "broken,", "fix", "it"], {
        sessionsDir,
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
      });
    } finally {
      console.log = originalLog;
      // Node stores process.env.X = undefined as the string "undefined".
      if (originalKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalKey;
    }

    expect(capture()?.messages.at(-1)).toEqual({
      role: "user",
      content: "/mode is broken, fix it",
    });
    expect(loadSession("ghi", sessionsDir).permissionMode).toBe("read-only");
  });
});

describe("run (/effort)", () => {
  let sessionsDir: string;
  let tmpConfigRoot: string;
  const originalKey = process.env.GROQ_API_KEY;
  const originalHome = process.env.HOME;
  const originalDisableModelsFetch = process.env.SERI_DISABLE_MODELS_FETCH;

  const REASONING_CATALOG = {
    groq: {
      models: {
        "reasoning-model": {
          id: "reasoning-model",
          name: "Reasoning Model",
          family: "test",
          tool_call: true,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
          limit: { context: 1000, output: 100 },
        },
        "plain-model": {
          id: "plain-model",
          name: "Plain Model",
          family: "test",
          tool_call: true,
          reasoning: false,
          limit: { context: 1000, output: 100 },
        },
      },
    },
    openrouter: { models: {} },
    anthropic: { models: {} },
    openai: { models: {} },
    google: { models: {} },
  };

  function restoreEnv(key: string, original: string | undefined): void {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-effort-sessions-"));
    tmpConfigRoot = mkdtempSync(join(tmpdir(), "seri-cli-test-effort-config-"));
    process.env.HOME = tmpConfigRoot;
    process.env.GROQ_API_KEY = "fake-test-key";
    delete process.env.SERI_DISABLE_MODELS_FETCH;
    resetCatalogCache();
  });

  afterEach(() => {
    restoreEnv("GROQ_API_KEY", originalKey);
    restoreEnv("HOME", originalHome);
    restoreEnv("SERI_DISABLE_MODELS_FETCH", originalDisableModelsFetch);
    resetCatalogCache();
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(tmpConfigRoot, { recursive: true, force: true });
  });

  function withReasoningFetch<T>(fn: () => Promise<T>): Promise<T> {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify(REASONING_CATALOG), { status: 200 })) as typeof fetch;
    return fn().finally(() => {
      globalThis.fetch = realFetch;
    });
  }

  function seedSession(
    id: string,
    overrides: Partial<SessionState<ModelMessage>> = {},
  ): SessionState<ModelMessage> {
    const session: SessionState<ModelMessage> = {
      id,
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      model: "reasoning-model",
      provider: "groq",
      messages: [],
      ...overrides,
    };
    saveSession(session, sessionsDir);
    return session;
  }

  test("/effort <level> on a session with that tier legal sets session.reasoningEffort", async () => {
    const session = seedSession("eff-1");

    await withReasoningFetch(() =>
      invokeSlash(
        "/effort",
        ["medium"],
        {
          sessionsDir,
          checkpointsDir: join(tmpConfigRoot, "checkpoints"),
          configDir: getConfigDir(),
        },
        session,
      ),
    );

    expect(loadSession("eff-1", sessionsDir).reasoningEffort).toBe("medium");
  });

  test("/effort <invalid-level> leaves session state unchanged and lists the actual legal tiers", async () => {
    seedSession("eff-2");

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await withReasoningFetch(() =>
        invokeSlash(
          "/effort",
          ["extreme"],
          {
            sessionsDir,
            checkpointsDir: join(tmpConfigRoot, "checkpoints"),
            configDir: getConfigDir(),
          },
          loadSession("eff-2", sessionsDir),
        ),
      );
    } finally {
      console.log = originalLog;
    }

    expect(loadSession("eff-2", sessionsDir).reasoningEffort).toBeUndefined();
    expect(logs.some((line) => line.includes("low, medium, high"))).toBe(true);
  });

  test("/effort auto clears session.reasoningEffort", async () => {
    const session = seedSession("eff-3", { reasoningEffort: "high" });

    await withReasoningFetch(() =>
      invokeSlash(
        "/effort",
        ["auto"],
        {
          sessionsDir,
          checkpointsDir: join(tmpConfigRoot, "checkpoints"),
          configDir: getConfigDir(),
        },
        session,
      ),
    );

    expect(loadSession("eff-3", sessionsDir).reasoningEffort).toBeUndefined();
  });

  test("a model with no reasoningOptions: /effort reports no tiers available rather than erroring", async () => {
    const session = seedSession("eff-4", { model: "plain-model" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await withReasoningFetch(() =>
        invokeSlash(
          "/effort",
          [],
          {
            sessionsDir,
            checkpointsDir: join(tmpConfigRoot, "checkpoints"),
            configDir: getConfigDir(),
          },
          session,
        ),
      );
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((line) => line.includes("no reasoning-effort tiers available"))).toBe(true);
  });

  test("`--effort` is an unknown option", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    let code: number;
    try {
      code = await run(["--effort", "high", "a", "task"], { sessionsDir });
    } finally {
      console.error = originalError;
    }
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/effort/i);
  });

  test("lists the gateway-routed entry's own legal tiers, not the unreachable native entry's", async () => {
    delete process.env.GROQ_API_KEY;
    seedSession("eff-7", { model: "gateway-model", provider: "groq" });
    saveAuthSession(
      {
        accessToken: "at-1",
        refreshToken: "rt-1",
        userId: "user_1",
        email: "a@example.com",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      },
      getConfigDir(),
    );

    const gatewayCatalog = {
      groq: {
        models: {
          "gateway-model": {
            id: "gateway-model",
            name: "Gateway Model (native, unreachable — no key)",
            family: "test",
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low"] }],
            limit: { context: 1000, output: 100 },
          },
        },
      },
      openrouter: {
        models: {
          "groq/gateway-model": {
            id: "groq/gateway-model",
            name: "Gateway Model (via gateway)",
            family: "test",
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
            limit: { context: 1000, output: 100 },
          },
        },
      },
      anthropic: { models: {} },
      openai: { models: {} },
      google: { models: {} },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/account-status")) {
        return new Response(JSON.stringify({ plan: "pro" }), { status: 200 });
      }
      return new Response(JSON.stringify(gatewayCatalog), { status: 200 });
    }) as typeof fetch;

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await invokeSlash(
        "/effort",
        [],
        {
          sessionsDir,
          checkpointsDir: join(tmpConfigRoot, "checkpoints"),
          configDir: getConfigDir(),
        },
        loadSession("eff-7", sessionsDir),
      );
    } finally {
      console.log = originalLog;
      globalThis.fetch = realFetch;
    }

    expect(logs.some((line) => line.includes("low, medium, high"))).toBe(true);
    expect(logs.some((line) => /Legal tiers for the current model: low\./.test(line))).toBe(false);
  });

  test("is registered with an at-most-one-argument accepts and mutatesRunState", () => {
    const effort = SLASH_COMMANDS.get("/effort");
    if (effort === undefined) throw new Error("/effort is not registered");
    expect(effort.accepts([])).toBe(true);
    expect(effort.accepts(["medium"])).toBe(true);
    expect(effort.accepts(["auto"])).toBe(true);
    expect(effort.accepts(["medium", "extra"])).toBe(false);
    expect(effort.mutatesRunState).toBe(true);
  });

  test("`/effort medium extra` stays a task, sent to the model, and does not touch session.reasoningEffort", async () => {
    seedSession("eff-extra-args");
    const { fake, capture } = fakeRunLoop();

    const originalLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await withReasoningFetch(() =>
        run(["--continue", "/effort", "medium", "extra"], {
          sessionsDir,
          runLoop: fake,
          loadAgentsFile: () => "",
          loadExtensions: () => ({
            skills: new Map(),
            rules: new Map(),
            hooks: { registry: new Map() },
          }),
        }),
      );
    } finally {
      console.log = originalLog;
    }

    expect(code).toBe(0);
    expect(capture()?.messages.at(-1)).toEqual({
      role: "user",
      content: "/effort medium extra",
    });
    expect(loadSession("eff-extra-args", sessionsDir).reasoningEffort).toBeUndefined();
  });
});

describe("run (/clear)", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-clear-sessions-"));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  test("is registered with an exact, empty accepts, mutatesRunState, and scopeTargetToCwd", () => {
    const clear = SLASH_COMMANDS.get("/clear");
    if (clear === undefined) throw new Error("/clear is not registered");
    expect(clear.accepts([])).toBe(true);
    expect(clear.accepts(["the", "screen", "please"])).toBe(false);
    expect(clear.accepts(["3"])).toBe(false);
    expect(clear.mutatesRunState).toBe(true);
    expect(clear.scopeTargetToCwd).toBe(true);
    for (const name of [
      "/undo",
      "/rewind",
      "/restore",
      "/mode",
      "/memory",
      "/compact",
      "/trajectory",
      "/usage",
    ]) {
      const command = SLASH_COMMANDS.get(name);
      if (command === undefined) throw new Error(`${name} is not registered`);
      expect(command.scopeTargetToCwd).toBeUndefined();
    }
  });

  test("/compact is registered with mutatesRunState so onSubmit refuses it mid-turn", () => {
    const compact = SLASH_COMMANDS.get("/compact");
    if (compact === undefined) throw new Error("/compact is not registered");
    expect(compact.mutatesRunState).toBe(true);
    expect(compact.accepts([])).toBe(true);
    expect(compact.accepts(["focus", "on", "the", "auth", "bug"])).toBe(true);
  });

  test("`/clear the screen please` stays a task, sent to the model, and does not touch the existing session", async () => {
    const originalKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "fake-test-key";
    const existing: SessionState = {
      id: "clear-hijack-1",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [],
    };
    saveSession(existing, sessionsDir);

    const { fake, capture } = fakeRunLoop();

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["/clear", "the", "screen", "please"], {
        sessionsDir,
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
      });
    } finally {
      console.log = originalLog;
      if (originalKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalKey;
    }

    expect(capture()?.messages.at(-1)).toEqual({
      role: "user",
      content: "/clear the screen please",
    });
    expect(loadSession("clear-hijack-1", sessionsDir)).toEqual(existing);
  });

  test("`/clear 3` stays a task, sent to the model, and does not touch the existing session", async () => {
    const originalKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "fake-test-key";
    const existing: SessionState = {
      id: "clear-hijack-2",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "read-only",
      messages: [],
    };
    saveSession(existing, sessionsDir);

    const { fake, capture } = fakeRunLoop();

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["/clear", "3"], {
        sessionsDir,
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
      });
    } finally {
      console.log = originalLog;
      if (originalKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalKey;
    }

    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "/clear 3" });
    expect(loadSession("clear-hijack-2", sessionsDir)).toEqual(existing);
  });

  test("calls the presenter in order: sessionUpdated -> transcriptCleared -> message", async () => {
    const existing: SessionState<ModelMessage> = {
      id: "order-1",
      cwd: ".",
      systemPrompt: "",
      permissionMode: "auto",
      messages: [{ role: "user", content: "hi" }],
    };
    saveSession(existing, sessionsDir);

    const calls: string[] = [];
    const fakePresenter = {
      message: () => {
        calls.push("message");
      },
      onPlan: () => {},
      restore: () => {},
      sessionUpdated: async () => {
        calls.push("sessionUpdated");
      },
      transcriptCleared: () => {
        calls.push("transcriptCleared");
      },
      usageAccrued: () => {},
      cancelled: () => {},
      currentSession: () => existing,
    };

    const clear = SLASH_COMMANDS.get("/clear");
    if (clear === undefined) throw new Error("/clear is not registered");
    if (clear.needsSession === false) throw new Error("/clear unexpectedly needs no session");
    await clear.run(
      existing,
      [],
      { sessionsDir, checkpointsDir: sessionsDir, configDir: sessionsDir },
      fakePresenter,
    );

    expect(calls).toEqual(["sessionUpdated", "transcriptCleared", "message"]);
  });

  test("`/clear` via SLASH_COMMANDS starts a new session, leaving the old one byte-identical", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seri-cli-test-clear-cwd-"));
    const existing: SessionState = {
      id: "old-session",
      cwd,
      systemPrompt: "a distinctive system prompt",
      permissionMode: "auto",
      model: "llama-3.3-70b-versatile",
      provider: "groq",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
      ],
    };
    saveSession(existing, sessionsDir);
    const before = loadSession("old-session", sessionsDir);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await invokeSlash(
        "/clear",
        [],
        { sessionsDir, checkpointsDir: sessionsDir, configDir: getConfigDir() },
        loadSession("old-session", sessionsDir),
      );
    } finally {
      console.log = originalLog;
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(loadSession("old-session", sessionsDir)).toEqual(before);

    const ids = listSessionIds(sessionsDir);
    expect(ids).toHaveLength(2);
    const newId = ids.find((id) => id !== "old-session");
    if (newId === undefined) throw new Error("no new session appeared");

    const loaded = loadSession(newId, sessionsDir);
    expect(loaded.messages).toEqual([]);
    expect(loaded.cwd).toBe(existing.cwd);
    expect(loaded.systemPrompt).toBe(
      buildSystemPrompt({ agentsContent: loadAgentsFile(cwd), skills: [], rules: [] }),
    );
    expect(loaded.systemPrompt).not.toBe(existing.systemPrompt);
    expect(loaded.permissionMode).toBe(existing.permissionMode);
    expect(loaded.model).toBe(existing.model);
    expect(loaded.provider).toBe(existing.provider);

    expect(logs.join("\n")).toContain(newId);
    expect(logs.join("\n")).toContain("old-session");
  });

  test("argv `/clear` is a task and does not mint via the slash handler", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const existing: SessionState = {
      id: "recent-session",
      cwd: process.cwd(),
      systemPrompt: "",
      permissionMode: "auto",
      messages: [{ role: "user", content: "hi" }],
    };
    saveSession(existing, sessionsDir);
    const { fake, capture } = fakeRunLoop();
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await run(["/clear"], {
        sessionsDir,
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
      });
      expect(code).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "/clear" });
    expect(loadSession("recent-session", sessionsDir).messages).toEqual([
      { role: "user", content: "hi" },
    ]);
  });
});

describe("run (/usage)", () => {
  test("is registered, needs no session, and accepts only [] or --detail", () => {
    const usage = SLASH_COMMANDS.get("/usage");
    if (usage === undefined) throw new Error("/usage is not registered");
    expect(usage.accepts([])).toBe(true);
    expect(usage.accepts(["--detail"])).toBe(true);
    expect(usage.accepts(["please"])).toBe(false);
    expect(usage.accepts(["--detail", "extra"])).toBe(false);
    expect(usage.needsSession).toBe(false);
    expect(usage.mutatesRunState).toBeUndefined();
  });
});

describe("run (/trajectory)", () => {
  test("is registered, needs no session, and accepts only [] or on|off", () => {
    const trajectory = SLASH_COMMANDS.get("/trajectory");
    if (trajectory === undefined) throw new Error("/trajectory is not registered");
    expect(trajectory.accepts([])).toBe(true);
    expect(trajectory.accepts(["on"])).toBe(true);
    expect(trajectory.accepts(["off"])).toBe(true);
    expect(trajectory.accepts(["please"])).toBe(false);
    expect(trajectory.accepts(["off", "now"])).toBe(false);
    expect(trajectory.needsSession).toBe(false);
    expect(trajectory.mutatesRunState).toBeUndefined();
  });
});

describe("run (/memory)", () => {
  let sessionsDir: string;
  let configDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-memory-sessions-"));
    configDir = mkdtempSync(join(tmpdir(), "seri-cli-test-memory-config-"));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test("`/memory pending` via argv is a task", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();
    const originalLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await run(["/memory", "pending"], {
        sessionsDir,
        authConfigDir: configDir,
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(code).toBe(0);
    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "/memory pending" });
  });

  test("SLASH_COMMANDS /memory pending still runs with no session", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await invokeSlash("/memory", ["pending"], {
        sessionsDir,
        checkpointsDir: sessionsDir,
        configDir,
      });
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain("No staged memory writes.");
    expect(listSessionIds(sessionsDir)).toHaveLength(0);
  });
});

describe.skipIf(!isGitAvailable())("run (/undo and /rewind)", () => {
  const SESSION_ID = "ckpt";
  const messages: ModelMessage[] = [
    { role: "user", content: "one" },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
    { role: "user", content: "two" },
    { role: "assistant", content: [{ type: "text", text: "b" }] },
  ];
  const originalHome = process.env.HOME;

  let root: string;
  let sessionsDir: string;
  let checkpointsDir: string;
  let workTree: string;
  let logs: string[];
  let errors: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  function seed(): void {
    writeFileSync(join(workTree, "a.txt"), "before\n");
    const snapshot = createCheckpointer({
      storeDir: checkpointStoreDir(checkpointsDir, workTree),
      worktree: workTree,
      sessionId: SESSION_ID,
      onWarning: () => {},
      cwd: workTree,
    });
    snapshot({ tool: "write_file", toolCallId: "c1", args: { path: "a.txt" }, rewindTo: 1 });
    writeFileSync(join(workTree, "a.txt"), "after\n");
    snapshot({ tool: "write_file", toolCallId: "c2", args: { path: "a.txt" }, rewindTo: 3 });
    writeFileSync(join(workTree, "a.txt"), "final\n");

    saveSession(
      { id: SESSION_ID, cwd: workTree, systemPrompt: "", permissionMode: "auto", messages },
      sessionsDir,
    );
  }

  function slashCall(
    name: string,
    args: string[],
    sDir: string = sessionsDir,
    cDir: string = checkpointsDir,
  ): Promise<void> {
    const session = loadSession<ModelMessage>(SESSION_ID, sDir);
    const trajectory = createTrajectoryWriter({
      dir: getTrajectoriesDir(getConfigDir()),
      sessionId: SESSION_ID,
      cwd: session.cwd,
      enabled: true,
      retentionDays: 14,
      onWarning: () => {},
    });
    return invokeSlash(
      name,
      args,
      {
        sessionsDir: sDir,
        checkpointsDir: cDir,
        configDir: getConfigDir(),
        trajectory,
      },
      session,
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "seri-cli-checkpoint-"));
    sessionsDir = join(root, "sessions");
    checkpointsDir = join(root, "checkpoints");
    workTree = join(root, "work");
    mkdirSync(workTree, { recursive: true });
    process.env.HOME = root;
    logs = [];
    errors = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (msg: string) => logs.push(String(msg));
    console.error = (msg: string) => errors.push(String(msg));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  });

  test("`--continue /undo` dispatches against the most-recent session", async () => {
    seed();

    await slashCall("/undo", ["2"]);
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
  }, 15_000);

  test("`--continue /rewind` dispatches against the most-recent session", async () => {
    seed();

    await slashCall("/rewind", []);
    expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages).toHaveLength(3);
  }, 15_000);

  test("/undo reports the diff, the restored path and the command that recovers what it replaced", async () => {
    seed();

    await slashCall("/undo", ["2"]);

    expect(logs.join("\n")).toContain("restored a.txt");
    expect(logs.join("\n")).toMatch(/The state this replaced is commit [0-9a-f]{40}\./);
    expect(logs.join("\n")).toMatch(/\/restore [0-9a-f]{40}/);
  }, 15_000);

  test("/undo writes a checkpoint record with op pre-undo", async () => {
    seed();

    await slashCall("/undo", ["2"]);
    const lines = readTrajectory(join(getTrajectoriesDir(getConfigDir()), `${SESSION_ID}.jsonl`));
    const checkpoint = lines.find((line) => (line as { kind?: string }).kind === "checkpoint") as
      | { op: string }
      | undefined;
    expect(checkpoint?.op).toBe("pre-undo");
  }, 15_000);

  test("the recovery command /undo prints puts back exactly the state it replaced", async () => {
    // git read-tree plus checkout-index -a -f is additive and leaves extra files.
    const storeDir = checkpointStoreDir(checkpointsDir, workTree);
    writeFileSync(join(workTree, "old.ts"), "old\n");
    createCheckpointer({
      storeDir,
      worktree: workTree,
      sessionId: SESSION_ID,
      onWarning: () => {},
      cwd: workTree,
    })({ tool: "write_file", toolCallId: "c1", args: { path: "old.ts" }, rewindTo: 1 });
    recordWrite(storeDir, join(workTree, "old.ts"), "old\n");
    rmSync(join(workTree, "old.ts"));
    writeFileSync(join(workTree, "new.ts"), "new\n");
    recordWrite(storeDir, join(workTree, "new.ts"), "new\n");
    saveSession(
      { id: SESSION_ID, cwd: workTree, systemPrompt: "", permissionMode: "auto", messages },
      sessionsDir,
    );

    await slashCall("/undo", []);
    expect(existsSync(join(workTree, "old.ts"))).toBe(true);
    expect(existsSync(join(workTree, "new.ts"))).toBe(false);

    const sha = logs.join("\n").match(/\/restore ([0-9a-f]{40})/)?.[1] ?? "";
    await slashCall("/restore", [sha]);
    expect(existsSync(join(workTree, "old.ts"))).toBe(false);
    expect(readFileSync(join(workTree, "new.ts"), "utf8")).toBe("new\n");
  }, 20_000);

  test("`--continue /restore <sha>` dispatches against the most-recent session", async () => {
    seed();

    await expect(slashCall("/restore", ["deadbeef"])).rejects.toThrow(
      /deadbeef is not a checkpoint/,
    );
  }, 15_000);

  test("a rewind invalidates the anchors recorded before it, instead of slicing into a rebuilt array", async () => {
    const nine: ModelMessage[] = Array.from({ length: 9 }, (_, i) =>
      i % 2 === 0
        ? { role: "user", content: `u${i}` }
        : { role: "assistant", content: [{ type: "text", text: `a${i}` }] },
    );
    writeFileSync(join(workTree, "a.txt"), "before\n");
    const snapshot = createCheckpointer({
      storeDir: checkpointStoreDir(checkpointsDir, workTree),
      worktree: workTree,
      sessionId: SESSION_ID,
      onWarning: () => {},
    });
    const record = (rewindTo: number) =>
      snapshot({
        tool: "write_file",
        toolCallId: `c${rewindTo}`,
        args: { path: join(workTree, "a.txt") },
        rewindTo,
      });
    for (const anchor of [1, 3, 5, 7]) record(anchor);
    saveSession(
      { id: SESSION_ID, cwd: workTree, systemPrompt: "", permissionMode: "auto", messages: nine },
      sessionsDir,
    );

    await slashCall("/rewind", ["2"]);
    expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages).toHaveLength(5);

    const resumed = loadSession<ModelMessage>(SESSION_ID, sessionsDir);
    resumed.messages = [...resumed.messages, ...nine.slice(0, 5)];
    saveSession(resumed, sessionsDir);
    for (const anchor of [6, 8]) record(anchor);

    await expect(slashCall("/rewind", ["3"])).rejects.toThrow(/since the last rewind/);
    expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages).toHaveLength(10);
  }, 30_000);

  test("/rewind truncates the conversation and leaves the filesystem byte-identical", async () => {
    seed();
    const before = readFileSync(join(workTree, "a.txt"));

    await slashCall("/rewind", ["2"]);
    expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages).toEqual(
      messages.slice(0, 1),
    );
    expect(readFileSync(join(workTree, "a.txt")).equals(before)).toBe(true);
  }, 15_000);

  test("/undo then /rewind lands on the same anchor as /rewind then /undo", async () => {
    seed();
    await slashCall("/undo", ["2"]);
    await slashCall("/rewind", ["2"]);
    const undoFirst = {
      file: readFileSync(join(workTree, "a.txt"), "utf8"),
      messages: loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages,
    };

    const root2 = mkdtempSync(join(tmpdir(), "seri-cli-checkpoint-"));
    try {
      const sessionsDir2 = join(root2, "sessions");
      const checkpointsDir2 = join(root2, "checkpoints");
      const workTree2 = join(root2, "work");
      mkdirSync(workTree2, { recursive: true });
      writeFileSync(join(workTree2, "a.txt"), "before\n");
      const snapshot = createCheckpointer({
        storeDir: checkpointStoreDir(checkpointsDir2, workTree2),
        worktree: workTree2,
        sessionId: SESSION_ID,
        onWarning: () => {},
        cwd: workTree2,
      });
      snapshot({ tool: "write_file", toolCallId: "c1", args: { path: "a.txt" }, rewindTo: 1 });
      writeFileSync(join(workTree2, "a.txt"), "after\n");
      snapshot({ tool: "write_file", toolCallId: "c2", args: { path: "a.txt" }, rewindTo: 3 });
      writeFileSync(join(workTree2, "a.txt"), "final\n");
      saveSession(
        { id: SESSION_ID, cwd: workTree2, systemPrompt: "", permissionMode: "auto", messages },
        sessionsDir2,
      );

      await slashCall("/rewind", ["2"], sessionsDir2, checkpointsDir2);
      await slashCall("/undo", ["2"], sessionsDir2, checkpointsDir2);

      expect(readFileSync(join(workTree2, "a.txt"), "utf8")).toBe(undoFirst.file);
      expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir2).messages).toEqual(
        undoFirst.messages,
      );
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
    expect(undoFirst.file).toBe("before\n");
  }, 20_000);

  test("clamps an anchor that outlived the array it indexed, and reports what was actually dropped", async () => {
    writeFileSync(join(workTree, "a.txt"), "before\n");
    createCheckpointer({
      storeDir: checkpointStoreDir(checkpointsDir, workTree),
      worktree: workTree,
      sessionId: SESSION_ID,
      onWarning: () => {},
      cwd: workTree,
    })({ tool: "write_file", toolCallId: "c1", args: { path: "a.txt" }, rewindTo: 9 });
    saveSession(
      {
        id: SESSION_ID,
        cwd: workTree,
        systemPrompt: "",
        permissionMode: "auto",
        messages: messages.slice(0, 2),
      },
      sessionsDir,
    );

    await slashCall("/rewind", []);
    expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages).toHaveLength(2);
    expect(logs.join("\n")).toContain("dropped 0 message(s), 2 remain");
  }, 30_000);

  test("a repeated /undo says nothing changed instead of reporting a second undo", async () => {
    seed();

    await slashCall("/undo", []);
    logs.length = 0;
    await slashCall("/undo", []);
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("after\n");
    expect(logs.join("\n")).toContain("Already at checkpoint 1; no file changed.");
    expect(logs.join("\n")).not.toContain("Undid to checkpoint");
  }, 20_000);

  test("a task whose first word is a slash command is sent to the model, and undoes nothing", async () => {
    seed();
    const originalKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake, capture } = fakeRunLoop();

    let code: number;
    try {
      code = await run(["--resume", SESSION_ID, "/undo", "the", "rename", "and", "try", "again"], {
        sessionsDir,
        checkpointsDir,
        runLoop: fake,
        loadAgentsFile: () => "",
        loadExtensions: () => ({
          skills: new Map(),
          rules: new Map(),
          hooks: { registry: new Map() },
        }),
      });
    } finally {
      // Node stores process.env.X = undefined as the string "undefined".
      if (originalKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalKey;
    }

    expect(code).toBe(0);
    expect(capture()?.messages.at(-1)).toEqual({
      role: "user",
      content: "/undo the rename and try again",
    });
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("final\n");
  }, 20_000);

  test("rewindCommand does not record the barrier until sessionUpdated's own promise resolves", async () => {
    seed();
    const session = loadSession<ModelMessage>(SESSION_ID, sessionsDir);
    const storeDir = checkpointStoreDir(checkpointsDir, workTree);

    let resolveSessionUpdated: (() => void) | undefined;
    const fakePresenter = {
      message: () => {},
      onPlan: () => {},
      restore: () => {},
      sessionUpdated: () =>
        new Promise<void>((resolve) => {
          resolveSessionUpdated = resolve;
        }),
      transcriptCleared: () => {},
      usageAccrued: () => {},
      cancelled: () => {},
      currentSession: () => session,
    };

    const rewind = SLASH_COMMANDS.get("/rewind");
    if (rewind === undefined) throw new Error("/rewind is not registered");
    if (rewind.needsSession === false) throw new Error("/rewind unexpectedly needs no session");
    const done = rewind.run(
      session,
      [],
      { sessionsDir, checkpointsDir, configDir: root },
      fakePresenter,
    );

    expect(readLog(storeDir, SESSION_ID).some((r) => r.kind === "rewind-barrier")).toBe(false);

    resolveSessionUpdated?.();
    await done;

    expect(readLog(storeDir, SESSION_ID).some((r) => r.kind === "rewind-barrier")).toBe(true);
  }, 15_000);
});

function compactionUsage(inputTotal: number, outputTotal: number) {
  return {
    inputTokens: {
      total: inputTotal,
      noCache: inputTotal,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
  };
}

describe("run (/compact)", () => {
  const SESSION_ID = "compact-session";

  let sessionsDir: string;
  let checkpointsDir: string;
  let configDir: string;
  let worktree: string;
  const originalEnv: Partial<Record<string, string>> = {};

  function restoreEnv(key: string, original: string | undefined): void {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-compact-sessions-"));
    checkpointsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-compact-checkpoints-"));
    configDir = mkdtempSync(join(tmpdir(), "seri-cli-test-compact-config-"));
    worktree = mkdtempSync(join(tmpdir(), "seri-cli-test-compact-work-"));
    for (const keyName of Object.values(PROVIDER_API_KEY_NAMES)) {
      originalEnv[keyName] = process.env[keyName];
      delete process.env[keyName];
    }
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(checkpointsDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    for (const [keyName, original] of Object.entries(originalEnv)) restoreEnv(keyName, original);
  });

  function longMessages(count: number): ModelMessage[] {
    const pad = "x".repeat(4000);
    const out: ModelMessage[] = [];
    for (let i = 0; i < count; i++) {
      out.push(
        i % 2 === 0
          ? { role: "user", content: `message ${i} ${pad}` }
          : { role: "assistant", content: [{ type: "text", text: `reply ${i} ${pad}` }] },
      );
    }
    return out;
  }

  function makeSession(messages: ModelMessage[]): SessionState<ModelMessage> {
    return {
      id: SESSION_ID,
      cwd: worktree,
      systemPrompt: "",
      permissionMode: "auto",
      model: "openai/gpt-oss-120b",
      provider: "groq",
      messages,
    };
  }

  function seedCheckpointLog(): string {
    const storeDir = checkpointStoreDir(checkpointsDir, worktree);
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, `${SESSION_ID}.jsonl`), "");
    return storeDir;
  }

  function getCompact() {
    const compact = SLASH_COMMANDS.get("/compact");
    if (compact === undefined) throw new Error("/compact is not registered");
    if (compact.needsSession === false) throw new Error("/compact unexpectedly needs no session");
    return compact;
  }

  test("compacts with confirmation: prints the summary line, persists the summarized session with the tail intact, appends a compaction barrier, and reports usage", async () => {
    const storeDir = seedCheckpointLog();
    const session = makeSession(longMessages(30));
    saveSession(session, sessionsDir);

    let doGenerateCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        doGenerateCalls++;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ goal: "g", progress: "p", blockers: "b", nextSteps: "n" }),
            },
          ],
          finishReason: { unified: "stop", raw: undefined },
          usage: compactionUsage(20, 10),
          warnings: [],
        };
      },
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await getCompact().run(
        session,
        [],
        { sessionsDir, checkpointsDir, configDir },
        testPresenter({ sessionsDir }, session),
        {
          authConfigDir: configDir,
          getGroqModel: () => model,
        },
      );
    } finally {
      console.log = originalLog;
    }

    expect(doGenerateCalls).toBe(1);
    expect(logs).toContain("⚙ compacted 10 messages");
    expect(logs).toContain("\n(tokens: 20 in, 10 out)");

    const saved = loadSession<ModelMessage>(SESSION_ID, sessionsDir);
    expect(saved.messages).toHaveLength(21);
    expect(saved.messages.slice(1)).toEqual(session.messages.slice(10));

    expect(readLog(storeDir, SESSION_ID).some((r) => r.kind === "compaction-barrier")).toBe(true);

    const firstUser = model.doGenerateCalls[0]?.prompt.find((part) => part.role === "user");
    const sent =
      firstUser && "content" in firstUser
        ? typeof firstUser.content === "string"
          ? firstUser.content
          : Array.isArray(firstUser.content)
            ? firstUser.content
                .map((part) =>
                  part && typeof part === "object" && "text" in part ? String(part.text) : "",
                )
                .join("")
            : ""
        : "";
    expect(sent).not.toContain("Additional focus");
  });

  test("optional instructions are appended to the summarizer prompt", async () => {
    seedCheckpointLog();
    const session = makeSession(longMessages(30));
    saveSession(session, sessionsDir);

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ goal: "g", progress: "p", blockers: "b", nextSteps: "n" }),
          },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: compactionUsage(20, 10),
        warnings: [],
      }),
    });

    const originalLog = console.log;
    console.log = () => {};
    try {
      await getCompact().run(
        session,
        ["focus", "on", "the", "auth", "bug"],
        { sessionsDir, checkpointsDir, configDir },
        testPresenter({ sessionsDir }, session),
        {
          authConfigDir: configDir,
          getGroqModel: () => model,
        },
      );
    } finally {
      console.log = originalLog;
    }

    const firstUser = model.doGenerateCalls[0]?.prompt.find((part) => part.role === "user");
    const sent =
      firstUser && "content" in firstUser
        ? typeof firstUser.content === "string"
          ? firstUser.content
          : Array.isArray(firstUser.content)
            ? firstUser.content
                .map((part) =>
                  part && typeof part === "object" && "text" in part ? String(part.text) : "",
                )
                .join("")
            : ""
        : "";
    expect(sent).toContain("Additional focus: focus on the auth bug");
  });

  test("no-op below the eviction boundary: leaves the session byte-identical, prints the no-op message, and never calls the model", async () => {
    const session = makeSession(longMessages(5));
    saveSession(session, sessionsDir);
    const before = loadSession(SESSION_ID, sessionsDir);

    let doGenerateCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        doGenerateCalls++;
        throw new Error("must not be called: this session has too little history to compact");
      },
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await getCompact().run(
        session,
        [],
        { sessionsDir, checkpointsDir, configDir },
        testPresenter({ sessionsDir }, session),
        {
          authConfigDir: configDir,
          getGroqModel: () => model,
        },
      );
    } finally {
      console.log = originalLog;
    }

    expect(doGenerateCalls).toBe(0);
    expect(logs).toEqual(["Not enough history to compact."]);
    expect(loadSession(SESSION_ID, sessionsDir)).toEqual(before);
    expect(readLog(checkpointStoreDir(checkpointsDir, worktree), SESSION_ID)).toEqual([]);
  });

  test("cancelled compaction is a strict no-op and reports the cancelling signal to the presenter", async () => {
    seedCheckpointLog();
    const session = makeSession(longMessages(30));
    saveSession(session, sessionsDir);
    const before = loadSession(SESSION_ID, sessionsDir);

    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let abortError: Error | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) => {
        resolveStarted();
        return await new Promise((_, reject) => {
          abortSignal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted.");
            err.name = "AbortError";
            abortError = err;
            reject(err);
          });
        });
      },
    });

    const messages: string[] = [];
    let cancelledSignal: NodeJS.Signals | undefined;
    const presenter = {
      message: (text: string) => messages.push(text),
      onPlan: () => {},
      restore: () => {},
      sessionUpdated: async () => {},
      transcriptCleared: () => {},
      usageAccrued: () => {},
      cancelled: (signal: NodeJS.Signals) => {
        cancelledSignal = signal;
      },
      currentSession: () => session,
    };

    let runError: unknown;
    try {
      const done = getCompact().run(
        session,
        [],
        { sessionsDir, checkpointsDir, configDir },
        presenter,
        { authConfigDir: configDir, getGroqModel: () => model },
      );
      await started;
      deliverSignal("SIGINT");
      await done;
    } catch (err) {
      runError = err;
    }

    expect(runError).toBeUndefined();
    expect(abortError?.name).toBe("AbortError");
    expect(loadSession(SESSION_ID, sessionsDir)).toEqual(before);
    expect(readLog(checkpointStoreDir(checkpointsDir, worktree), SESSION_ID)).toEqual([]);
    expect(messages).toEqual(["⚙ compacting…"]);
    expect(cancelledSignal).toBe("SIGINT");
  });

  test("a successful compaction frees the onSignalCancel slot, so a later signal is not silently swallowed", async () => {
    const session = makeSession(longMessages(30));
    saveSession(session, sessionsDir);

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ goal: "g", progress: "p", blockers: "b", nextSteps: "n" }),
          },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: compactionUsage(20, 10),
        warnings: [],
      }),
    });

    await getCompact().run(
      session,
      [],
      { sessionsDir, checkpointsDir, configDir },
      testPresenter({ sessionsDir }, session),
      {
        authConfigDir: configDir,
        getGroqModel: () => model,
      },
    );

    const sigintListeners = process.listeners("SIGINT");
    const sigtermListeners = process.listeners("SIGTERM");
    const originalKill = process.kill.bind(process);
    let killedWithSignal: string | number | undefined;
    process.kill = ((pid: number, signal?: string | number) => {
      killedWithSignal = signal;
      return true;
    }) as typeof process.kill;
    try {
      deliverSignal("SIGINT");
    } finally {
      process.kill = originalKill;
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
      for (const listener of sigintListeners) process.on("SIGINT", listener as () => void);
      for (const listener of sigtermListeners) process.on("SIGTERM", listener as () => void);
    }

    expect(killedWithSignal).toBe("SIGINT");
  });

  test("a permissionMode change made mid-compact survives — sessionUpdated merges onto the live session, not compactCommand's own stale snapshot", async () => {
    const session = makeSession(longMessages(30));
    saveSession(session, sessionsDir);

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ goal: "g", progress: "p", blockers: "b", nextSteps: "n" }),
          },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: compactionUsage(20, 10),
        warnings: [],
      }),
    });

    const liveSession: SessionState<ModelMessage> = { ...session, permissionMode: "read-only" };
    let updated: SessionState<ModelMessage> | undefined;
    const presenter = {
      message: () => {},
      onPlan: () => {},
      restore: () => {},
      sessionUpdated: async (next: SessionState<ModelMessage>) => {
        updated = next;
      },
      transcriptCleared: () => {},
      usageAccrued: () => {},
      cancelled: () => {},
      currentSession: () => liveSession,
    };

    await getCompact().run(session, [], { sessionsDir, checkpointsDir, configDir }, presenter, {
      authConfigDir: configDir,
      getGroqModel: () => model,
    });

    expect(updated?.permissionMode).toBe("read-only");
    expect(updated?.messages.length).toBeLessThan(session.messages.length);
  });
});

describe("tuiPresenter", () => {
  test("usageAccrued calls the supplied fold with the usage it was given", () => {
    const received: LanguageModelUsage[] = [];
    const presenter = tuiPresenter(
      () => {},
      () => Promise.resolve(),
      () => {
        throw new Error("not exercised by this test");
      },
      (usage) => received.push(usage),
    );
    const usage: LanguageModelUsage = {
      inputTokens: 20,
      inputTokenDetails: {
        noCacheTokens: 20,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: 10,
      outputTokenDetails: { textTokens: 10, reasoningTokens: undefined },
      totalTokens: 30,
    };

    presenter.usageAccrued(usage);

    expect(received).toEqual([usage]);
  });
});

describe("addCost", () => {
  const actual: CostReport = { amountUsd: 0.0001, status: "actual", source: "provider_cost_api" };
  const estimated: CostReport = {
    amountUsd: 0.002,
    status: "estimated",
    source: "provider_models_api",
  };
  const unknown: CostReport = { amountUsd: undefined, status: "unknown", source: "none" };

  test("one report, the other undefined: returns the defined one unchanged", () => {
    expect(addCost(undefined, actual)).toEqual(actual);
    expect(addCost(actual, undefined)).toEqual(actual);
    expect(addCost(undefined, undefined)).toBeUndefined();
  });

  test("estimated then actual: sums the amount, keeps status estimated (the weaker one)", () => {
    const combined = addCost(estimated, actual);
    expect(combined?.amountUsd).toBeCloseTo(0.0021, 6);
    expect(combined?.status).toBe("estimated");
    expect(combined?.source).toBe("provider_models_api");
  });

  test("actual then estimated: order doesn't matter, still degrades to estimated", () => {
    const combined = addCost(actual, estimated);
    expect(combined?.amountUsd).toBeCloseTo(0.0021, 6);
    expect(combined?.status).toBe("estimated");
  });

  test("estimated then unknown: degrades to unknown, keeps the known partial amount", () => {
    const combined = addCost(estimated, unknown);
    expect(combined?.status).toBe("unknown");
    expect(combined?.source).toBe("none");
    expect(combined?.amountUsd).toBeCloseTo(0.002, 6);
  });

  test("actual then unknown: degrades all the way to unknown even from the strongest status", () => {
    const combined = addCost(actual, unknown);
    expect(combined?.status).toBe("unknown");
  });
});
