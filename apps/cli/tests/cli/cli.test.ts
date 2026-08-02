import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import { run } from "../../src/cli";
import type { LoopEvent, runLoop } from "../../src/loop/loop";
import { toolDefinitions } from "../../src/provider/tools";
import { loadSession, saveSession, type SessionState } from "../../src/session/session";

describe("run", () => {
  test("--version prints the package.json version and returns 0", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    const code = await run(["--version"]);

    console.log = originalLog;
    expect(code).toBe(0);
    expect(logs).toEqual([`hesper ${pkg.version}`]);
  });
});

describe("run (task invocation)", () => {
  const originalKey = process.env.GROQ_API_KEY;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalHome = process.env.HOME;
  let sessionsDir: string;
  let tmpConfigRoot: string;

  function restoreEnv(key: string, original: string | undefined): void {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "hesper-cli-test-sessions-"));
    // Redirect the config dir to an empty temp dir so a real config.json on this machine
    // can never supply GROQ_API_KEY and mask the "unset" case (same guard as groq.test.ts).
    tmpConfigRoot = mkdtempSync(join(tmpdir(), "hesper-cli-test-config-"));
    if (process.platform === "win32") process.env.LOCALAPPDATA = tmpConfigRoot;
    else process.env.HOME = tmpConfigRoot;
  });

  afterEach(() => {
    restoreEnv("GROQ_API_KEY", originalKey);
    restoreEnv("LOCALAPPDATA", originalLocalAppData);
    restoreEnv("HOME", originalHome);
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(tmpConfigRoot, { recursive: true, force: true });
  });

  test("missing GROQ_API_KEY returns a non-zero exit code instead of crashing", async () => {
    delete process.env.GROQ_API_KEY;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));

    let code: number;
    try {
      code = await run(["do", "a", "task"], { sessionsDir, loadAgentsFile: () => "" });
    } finally {
      console.error = originalError;
    }

    expect(code).not.toBe(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("constructs runLoop with the expected messages, permissionMode, and tools", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let captured: RunLoopOpts | undefined;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      captured = opts;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));

    let code: number;
    try {
      code = await run(["write", "hello.txt"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        sessionsDir,
      });
    } finally {
      console.log = originalLog;
    }

    expect(code).toBe(0);
    expect(captured).toBeDefined();
    expect(captured?.permissionMode).toBe("read-only");
    expect(captured?.tools).toBe(toolDefinitions);
    expect(captured?.messages.at(-1)).toEqual({ role: "user", content: "write hello.txt" });
    expect(captured?.messages).toHaveLength(1);
    expect(captured?.system).toBe("You are Hesper, a coding agent.");
  });
});

describe("run (login/signup/logout)", () => {
  const failIfCalled = (name: string) => () => {
    throw new Error(`${name} should not be called`);
  };

  test("`hesper login` calls deps.login with mode 'login' and never touches the model/loop/session code", async () => {
    let captured: [string, string, string] | undefined;
    const code = await run(["login"], {
      login: async (mode, clientId, configDir) => {
        captured = [mode, clientId, configDir];
      },
      authConfigDir: "fake-config-dir",
      getGroqModel: failIfCalled("getGroqModel"),
      loadAgentsFile: failIfCalled("loadAgentsFile"),
    });

    expect(code).toBe(0);
    expect(captured?.[0]).toBe("login");
    expect(captured?.[2]).toBe("fake-config-dir");
  });

  test("`hesper signup` calls deps.login with mode 'signup'", async () => {
    let capturedMode: string | undefined;
    const code = await run(["signup"], {
      login: async (mode) => {
        capturedMode = mode;
      },
      authConfigDir: "fake-config-dir",
      getGroqModel: failIfCalled("getGroqModel"),
      loadAgentsFile: failIfCalled("loadAgentsFile"),
    });

    expect(code).toBe(0);
    expect(capturedMode).toBe("signup");
  });

  test("deps.login throwing returns a non-zero exit code instead of an unhandled rejection", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));

    let code: number;
    try {
      code = await run(["login"], {
        login: async () => {
          throw new Error("device code request failed: 429");
        },
        authConfigDir: "fake-config-dir",
        getGroqModel: failIfCalled("getGroqModel"),
        loadAgentsFile: failIfCalled("loadAgentsFile"),
      });
    } finally {
      console.error = originalError;
    }

    expect(code).not.toBe(0);
    expect(errors).toEqual(["device code request failed: 429"]);
  });

  test("`hesper logout` calls deps.logout and never touches the model/loop/session code", async () => {
    let capturedConfigDir: string | undefined;
    const code = await run(["logout"], {
      logout: (configDir) => {
        capturedConfigDir = configDir;
      },
      authConfigDir: "fake-config-dir",
      getGroqModel: failIfCalled("getGroqModel"),
      loadAgentsFile: failIfCalled("loadAgentsFile"),
    });

    expect(code).toBe(0);
    expect(capturedConfigDir).toBe("fake-config-dir");
  });
});

describe("run (/mode)", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "hesper-cli-test-mode-sessions-"));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  test("`--resume /mode` cycles the most-recent session's mode instead of misparsing /mode as a session id", async () => {
    const existing: SessionState = { id: "abc", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [] };
    saveSession(existing, sessionsDir);

    const code = await run(["--resume", "/mode"], { sessionsDir });

    expect(code).toBe(0);
    expect(readdirSync(sessionsDir)).toHaveLength(1);
    expect(loadSession("abc", sessionsDir).permissionMode).toBe("approve-each");
  });

  test("bare `/mode` (no --resume) cycles the most-recent session instead of creating a new orphan session", async () => {
    const existing: SessionState = { id: "def", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [] };
    saveSession(existing, sessionsDir);

    const code = await run(["/mode"], { sessionsDir });

    expect(code).toBe(0);
    expect(readdirSync(sessionsDir)).toHaveLength(1);
    expect(loadSession("def", sessionsDir).permissionMode).toBe("approve-each");
  });
});
