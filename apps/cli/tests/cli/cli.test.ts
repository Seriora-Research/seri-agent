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
import { getConfigDir, getTrajectoriesDir } from "../../src/config/paths";
import type { ApprovalAnswer, LoopEvent, runLoop } from "../../src/loop/loop";
import { loadGrants, permissionsPath, projectKey } from "../../src/permissions/store";
import type { CostReport } from "../../src/provider/cost";
import { getGroqModel } from "../../src/provider/groq";
import { configuredProviders, PROVIDER_API_KEY_NAMES } from "../../src/provider/keys";
import { DISPATCH_TOOL_NAME, toolDefinitions } from "../../src/provider/tools";
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

// A presenter for tests that don't care about presentation, only that a command ran and did what
// it says on the tin — console.log-based, the same shape production's now-deleted consolePresenter
// used to have before the launch-only argv refactor removed its only caller (handleSlashCommand).
// `session` backs `currentSession()`, read only by /compact.
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
  // Temp dirs a single test needs, torn down by the shared afterEach below.
  const extraTmpDirs: string[] = [];

  function restoreEnv(key: string, original: string | undefined): void {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }

  // The save/stub/try/finally/restore block the tests below repeated verbatim. `console.error` is
  // silenced rather than collected because none of them asserts on it — the ones that reach it (a
  // provider error, a run stopped at a cap) only ever needed it kept out of the test output. A
  // test that wants to assert on stderr stubs it itself, as the two that do already have.
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
    // Redirect the config dir to an empty temp dir so a real config.json on this machine
    // can never supply GROQ_API_KEY and mask the "unset" case (same guard as groq.test.ts).
    tmpConfigRoot = mkdtempSync(join(tmpdir(), "seri-cli-test-config-"));
    process.env.HOME = tmpConfigRoot;
    // Every test in this file that reaches prepareSession goes through getModelCatalog(), which
    // wraps @seri/model-catalog's own loadCatalog() — a MODULE-LEVEL cache shared by every test
    // file in the same process, not scoped to this describe block. apps/cli's own package-level
    // `"test": "SERI_DISABLE_MODELS_FETCH=1 bun test"` script normally guarantees the deterministic
    // bundled-fallback path, but that guarantee is invisible here: a bare repo-root `bun test`
    // (which runs every package's test files in ONE shared process, not through any package
    // script) does not set it, and packages/model-catalog/tests/catalog.test.ts's own "caches
    // in-memory for the process" test populates that same cache with a fake 2-entry catalog and
    // never resets it after its own describe block — whichever test runs next in the process
    // inherits it. Reset the cache and force the deterministic path explicitly, rather than
    // trusting the ambient env var or the order test files happen to run in.
    resetCatalogCache();
    process.env.SERI_DISABLE_MODELS_FETCH = "1";
  });

  afterEach(() => {
    restoreEnv("GROQ_API_KEY", originalKey);
    restoreEnv("HOME", originalHome);
    restoreEnv("SERI_DISABLE_MODELS_FETCH", originalDisableModelsFetch);
    // Cleared on the way out too, so a real catalog this file legitimately cached does not become
    // the NEXT file's own stale leak in the same shared process.
    resetCatalogCache();
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(tmpConfigRoot, { recursive: true, force: true });
    // Cleaned here rather than at the end of the test that made it, so a failing assertion leaks
    // nothing either.
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

  // D2/D3 (feature-plan.md, multi-provider-byok-phase-2): routing-priority resolution on the
  // non-interactive path. DEFAULT_MODEL ("openai/gpt-oss-120b", groq.ts) is one of the bundled
  // manifest's own groq<->openrouter exact-id collisions (routes.manifest.test.ts's own fixture
  // class), so a fresh session with GROQ_API_KEY unset and OPENROUTER_API_KEY set reroutes there
  // without any explicit /model pick.
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
      // Not covered by this describe block's own shared afterEach (which only restores
      // GROQ_API_KEY/HOME) — this test is the only one here that touches OPENROUTER_API_KEY.
      delete process.env.OPENROUTER_API_KEY;
    }

    expect(code).toBe(0);
    // D4: the call is actually made against the RESOLVED pair, not the requested one.
    expect(capture()?.provider).toBe("openrouter");
    expect(capture()?.modelId).toBe("openai/gpt-oss-120b");
    // D2's own transparency rule: never silent. But since no provider was ever actually
    // requested (DEFAULT_PROVIDER is a synthetic fallback, not a user choice), the notice must
    // not blame a provider the user never named.
    expect(errors.some((line) => line.includes("routing openai/gpt-oss-120b via openrouter"))).toBe(
      true,
    );
    expect(errors.some((line) => /groq/i.test(line))).toBe(false);
  });

  // The counterpart of the reroute test just above: here the provider was actually named (a
  // persisted SERI_PROVIDER, the config-write side of a prior /model pick), not merely
  // resolveDefaultModel's own DEFAULT_PROVIDER fallback — so the notice must name it.
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

  // A resumed session's reroute notice must blame whichever provider it is ACTUALLY routing away
  // from on THIS turn, read straight off the session's own persisted `provider` — not a request
  // from before the session was ever created. `provider` here is seeded directly as "openrouter"
  // (simulating what an earlier turn confirmed, the same value loadOrCreateSession's resume branch
  // passes straight through, unmodified), then the keys are swapped so openrouter now has none and
  // groq does — proving the notice names openrouter (what this resume is actually routing away
  // from), not groq (which merely happens to be where it reroutes to).
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

  // The gateway counterpart to the reroute-notice tests above: a gateway-credential route (no local key
  // anywhere, but a logged-in plan covers it) must warn on the non-interactive path exactly like a
  // BYOK reroute already does — otherwise a scripted run silently bills against the user's own
  // seri plan with no indication it ever left their own keys. This is a genuinely blank first run
  // (no --provider, no SERI_PROVIDER, no seeded session) — session.provider stays undefined, so
  // the notice must not blame DEFAULT_PROVIDER ("Groq") for a provider the user never named
  // (matches rerouteNotice's own undefined-provider branch, tested above).
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
      errors.some(
        (line) =>
          line.includes("routing openai/gpt-oss-120b via openrouter") &&
          line.includes("on your seri plan"),
      ),
    ).toBe(true);
    // The regression: session.provider was never set on this blank first run, so the notice must
    // not blame DEFAULT_PROVIDER ("Groq") for a provider the user never requested.
    expect(errors.some((line) => line.includes("key configured"))).toBe(false);
  });

  // The defined-provider sibling of the test above: a resumed session that explicitly pinned
  // "openrouter" (mirroring "a resumed session's reroute notice blames its own persisted
  // provider" above) DID name a provider, and that provider genuinely has no key — so this time
  // the notice must include the blame clause, naming the provider the session actually requested.
  test("routes via the gateway on a resumed session, and blames the session's own persisted provider", async () => {
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
      errors.some(
        (line) =>
          line.includes("routing openai/gpt-oss-120b via openrouter") &&
          line.includes("on your seri plan") &&
          line.includes("no OpenRouter key configured"),
      ),
    ).toBe(true);
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

  // Non-interactive counterpart of tuiPty.test.ts's "--continue mount" pair: connectDispatch already
  // skips a turn when the resumed session's last message is a finished assistant reply; the piped
  // path used to call driveLoop anyway and burn a model turn the user did not ask for. The
  // unanswered-user case just above is the positive control — this one is the skip.
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

  // The negative control that splitting --resume into --resume <id> / --continue did not break the
  // surviving half: this passes on `main` too.
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
    // Cwd-bound tools (one factory per session directory), with filesystem-mutating tools wrapped
    // for checkpointing, plus dispatch_subagents from driveLoop's withSubagents composition.
    expect(Object.keys(capture()?.tools ?? {})).toEqual([
      ...Object.keys(toolDefinitions),
      "dispatch_subagents",
    ]);
    expect(capture()?.tools.write_file).not.toBe(toolDefinitions.write_file);
    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "write hello.txt" });
    expect(capture()?.messages).toHaveLength(1);
    // The assembled prompt, not the bare identity line: with no AGENTS.md this used to be 29
    // characters of identity and no tool guidance at all. The per-turn volatile tier (which model
    // this run actually is) is appended after it — see driveLoop's system composition.
    expect(
      capture()?.system?.startsWith(
        buildSystemPrompt({ agentsContent: "", skills: [], rules: [] }),
      ),
    ).toBe(true);
    expect(capture()?.system).toMatch(/You are powered by the model named/);
  });

  // Design-question fix (this PR's own follow-up, echo/storage mismatch): prepareSession used to
  // store ctx.taskText raw, while onSubmit's interactive path (cli.ts) always trims — leaving the
  // argv-task path storing/sending padded whitespace to the model even though its own TUI echo
  // (echoUserInput) already trims for display. Trimming here brings the two paths into agreement.
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

  // Two assertions, because the one at :153 above would pass if the mode reached the loop but
  // never made it to the session file on disk.
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

  // Landmine 2's test: the flag overrides the loop's live view without ever reaching disk.
  // Negative control: assigning session.permissionMode = "auto" in driveLoop instead of using the
  // local override at cli.ts's opts literal turns this red.
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

  // 21. The hard constraint, at the integration level: `bash` can never reach the store through
  // this path, because rememberGrant refuses to persist it (permissions/store.ts). Extends the
  // test above rather than duplicating its setup.
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

  // The second of the two sites output.ts's escapeControlChars covers: event.name here is the
  // same model-supplied call.toolName the approval prompt renders (pinned separately in the
  // "control character in the tool name" test), reached after the fact rather than at a prompt.
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

  // Success check 4's exit-code half: a run stopped by repeated denials leaves the user's task as
  // unanswered as one that hit the iteration cap, so it gets the same non-zero exit.
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

  // The regression this closes: approve-each is now the default and EOF resolves "no" (this PR's
  // own earlier fix), so a run with no human present — CI, a cron job, `< /dev/null` — now reaches
  // exactly this path on its first write: asked for permission, nobody was there, did nothing, and
  // used to report success. Measured on the compiled binary before this fix: exit 0, no file.
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

  // The regression guard for the fix above: `seri "explain this repo"` calls nothing, is refused
  // nothing, and answers with text — the most common invocation there is. If the exit-1 condition
  // is too broad this goes red instead of the case it is meant to catch.
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

  // The other half of getting the boundary right: the user said no to one thing, the model did
  // something else, and the turn finished having accomplished it. That is a normal, successful
  // session, not a refusal — only "denied AND accomplished nothing" is exit 1, not "denied at all".
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

  // repeated-denials is unconditionally 1 already (doneReason !== "no-tool-call" falls straight to
  // the final `return 1`) — this pins that the new no-tool-call-only check does not creep onto it.
  // A tool DID run here (ranTool: true) precisely so the check would wrongly flip this to 0 if it
  // were ever applied outside the `no-tool-call` branch.
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

  // Symptom A from round 6's review: a read-only session that correctly refuses a write probe is
  // the mode doing exactly what the user selected, not a failure — `seri --resume x "review this
  // repo" && open report.md` must not break the `&&` over that. Before this fix, a "blocked" and a
  // "declined" permission-denied were indistinguishable to driveLoop and this exited 1.
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

  // PR A (session-persisted allowedTools) is still out of scope: the session FILE never carries
  // this field, on any tool. `bash` specifically leaves the permanent store empty too — it is never
  // persistable (permissions/store.ts) — so a later --continue's seed is `[]`, not `undefined`:
  // `allowedTools` is now passed to runLoop on every run (cli.ts's driveLoop), and the store it is
  // read from is empty. This assertion is a real check, not churn — if it comes back non-empty,
  // `bash` reached the store.
  test("tool-allowed leaves no allowedTools field on the session file, and --continue seeds an empty allowlist", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    // tool-allowed comes AFTER messages-updated so it is the run's last write to disk — if a
    // future change persisted it, this ordering is what would catch a write that only looks
    // absent because a later messages-updated overwrote it back out.
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

    // First run ended on an assistant reply (answeredTurn), so a bare `--continue` would skip
    // the turn. New task text is what actually starts the next one — the seed under test.
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

  // A turn the provider answered, which is what makes the model worth recording. The bare `done`
  // the other tests use is a run that reached the model and got nothing back, and it deliberately
  // records no model — see the two tests after this one.
  const answeredTurn: LoopEvent[] = [
    { type: "messages-updated", messages: [{ role: "assistant", content: "ok" }] },
    { type: "done", reason: "no-tool-call" },
  ];

  // The model is resolved once and recorded on the session, which is what a later /model has to
  // change. Without the record, `--continue` would silently re-resolve from the environment and
  // undo the switch on the next turn.
  test("records the resolved model on a new session and keeps a resumed session's own", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    // Captured rather than deleted afterwards: this box may legitimately have SERI_MODEL set, and
    // reassigning a captured undefined would leave the literal string "undefined" behind.
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

  // The prompt is derived from this binary plus AGENTS.md, not carried as conversation state. A
  // session created before src/agents/systemPrompt.ts existed has the 29-character identity line
  // frozen into its JSON, and resuming it used to hand that straight to the model — no tool
  // guidance, on exactly the sessions a user upgrading has.
  test("a resumed session is run with the rebuilt prompt, not the one frozen into its file", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    // A cwd that is deliberately not the process's, to pin which one the AGENTS.md lookup uses.
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

  // Scenario b (feature-plan.md): a brand-new session (no --continue/--resume) starts on whatever
  // a previously successful /model pick persisted to config.json, not the built-in default.
  // Negative control in the same test: an empty config still resolves to the built-in
  // openai/gpt-oss-120b/groq pair — proof a resolver that ignored config entirely would fail one
  // half of this pair, not silently pass both.
  test("a brand-new session starts on the persisted model/provider, or the built-in default when none was picked", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const askedOpenRouter: string[] = [];
    const { code: firstCode } = await captureLogs(() =>
      run(["a", "task"], {
        // answeredTurn, not the bare-done default: a model is only recorded on the session file
        // once a turn actually answered (loadOrCreateSession's own comment above) — this test
        // needs that recording to check which model/provider a brand-new session resolved to.
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
    // With an empty config, the persisted pair isn't there yet, so this first run must have used
    // the built-in default.
    expect(firstCode).toBe(0);
    expect(askedOpenRouter).toEqual([]);
    const firstId = listSessionIds(sessionsDir)[0]!;
    const firstSession = loadSession(firstId, sessionsDir);
    expect(firstSession.model).toBe("openai/gpt-oss-120b");
    // No provider was ever explicitly requested here (no SERI_PROVIDER, no /model pick), so
    // `provider` stays undefined rather than recording the routing default as if it had been.
    expect(firstSession.provider).toBeUndefined();
    expect(existsSync(join(tmpConfigRoot, ".seri", "config.json"))).toBe(false);

    // Now persist a pick the way a successful /model switch would (cli.ts's own runTui write
    // site), and start ANOTHER brand-new session.
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

  // code-review finding on PR #71: CliDeps was never extended with getAnthropicModel/
  // getOpenAIModel/getGoogleModel (unlike getGroqModel/getOpenRouterModel, already here) even
  // though model.ts's own ModelDeps was — so neither of cli.ts's two getModel() call sites could
  // inject a fake for the 3 new providers, leaving them reachable only through the real,
  // network-calling implementations from this file's own tests. This is the wiring proof for one
  // of the three (anthropic); the other two thread through the exact same CliDeps fields.
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

  // The case `loaded.model ?? resolveModelId()` exists for, and the only one the two tests above
  // do not reach: a session file written before `model` was a field. It must still load, and it
  // must acquire a model rather than resuming with none.
  test("a session saved without a model backfills one on resume and persists it", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const originalModel = process.env.SERI_MODEL;
    process.env.SERI_MODEL = "model-from-env";
    const asked: string[] = [];

    try {
      // Written the way a pre-`model` seri wrote it: the field is absent from the header, not
      // undefined. No messages, so the file is just the header line.
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

  // HIGH finding (code-review on PR #71): the backfill used to pair resolveModelId() (SERI_MODEL
  // only) with an independently-hardcoded "groq" provider — so a persisted non-groq
  // SERI_MODEL/SERI_PROVIDER pair (a normal side effect of any successful /model pick, per
  // persistDefaultModel) backfilled to a MISMATCHED pair, e.g. an anthropic model id called
  // through getGroqModel, failing confusingly at the API boundary. The fix backfills model AND
  // provider together via resolveDefaultModel(), so a legacy session with no `model` field always
  // backfills to a real, consistent pair — proven here with a persisted non-groq (openrouter) pair.
  test("a session with no model backfills the persisted non-groq pair, not a mismatch", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const asked: string[] = [];

    setConfigValue("SERI_MODEL", "picked-model");
    setConfigValue("SERI_PROVIDER", "openrouter");

    // Written the way a pre-`model` seri wrote it: the field is absent from the header, not
    // undefined. No messages, so the file is just the header line.
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

  // getGroqModel takes any string, so a typo only surfaces as a provider 404 once the run is under
  // way. Recording it at creation would mint a session pinned to an id that cannot work, and
  // `--continue` — the obvious retry — would re-read it and fail the same way with a corrected
  // SERI_MODEL sitting right there in the environment. Nothing answered, so nothing is pinned.
  test("a model that never produced a turn is not recorded, so a corrected SERI_MODEL takes effect", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const originalModel = process.env.SERI_MODEL;
    process.env.SERI_MODEL = "openai/gpt-os-120b"; // the typo: one 's'
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

      // The correction the user makes next, and the resume that has to honour it.
      process.env.SERI_MODEL = "openai/gpt-oss-120b";
      const { code } = await captureLogs(() => run(["--resume", id, "again"], deps(answeredTurn)));
      expect(code).toBe(0);
      expect(asked.at(-1)).toBe("openai/gpt-oss-120b");
      expect(loadSession(id, sessionsDir).model).toBe("openai/gpt-oss-120b");
    } finally {
      restoreEnv("SERI_MODEL", originalModel);
    }
  });

  // cli.ts is the only thing that constructs the controller — runLoop is a library that is handed a
  // signal and never makes one — so if this stops arriving, every abort check downstream (the
  // streamText round-trip, the compaction round-trip, the per-tool guard, spawnCollect, runRipgrep)
  // is dead code that keeps passing its own tests.
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

  // The prompt is where a cancel is easiest to lose: the loop is parked in rl.question when Ctrl-C
  // arrives, and a readline nobody closes never settles, so the turn would hang until the user
  // pressed again — which kills the process before the tool row is written and leaves the session
  // unresumable. Exercised through the prompt runLoop is actually given, because makeApprovalPrompt
  // is not exported and the wiring is half of what is being asserted.
  test("the approval prompt it gives runLoop resolves no on abort instead of hanging", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const answers: (ApprovalAnswer | undefined)[] = [];
    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      // Aborted while the prompt is already open, which is the real sequence, and then aborted
      // before it is opened at all — an already-aborted signal fires no abort event, so a listener
      // on its own would wait forever for something that has already happened.
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

  // The ordering trap this guards: rl.close() inside the question-answered path (makeApprovalPrompt)
  // emits 'close' SYNCHRONOUSLY, before that path's own resolve() runs, so a close listener that
  // does not check `answered` first would resolve "no" before the real answer ever gets a chance —
  // turning every real "y"/"a" into "no". "once" vs "no" is what makes this a real negative
  // control: an unguarded listener produces "no" here too, so a test whose expected answer is also
  // "no" could not tell the two apart.
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

  // The regression this guards: approve-each is now the default, so a run with no human at the
  // terminal at all — CI, a cron job, `seri "..." < /dev/null` — reaches this prompt on its first
  // write. ONE stream for the whole run, ended ONCE before any prompt opens — this is what makes
  // it faithful to production: `process.stdin` is a single shared stream, and a `< /dev/null`
  // launch is already fully at EOF before the first prompt ever reads it. The first Interface
  // created is what actually starts consuming it and discovers that, so its own 'close' fires
  // correctly (`answers[0]` is "no"). A SECOND Interface, opened on the same stream after the
  // first has already drained it to 'end', attaches its listeners AFTER that event already
  // happened — EventEmitters do not replay past events to a late listener — so its 'close' never
  // fires and its question's callback never runs: the promise hangs forever. A fresh PassThrough
  // per prompt (what this test used to do, and why it stayed green while this was broken) gives
  // each prompt its own independent EOF and hides exactly this failure. Raced against a timeout so
  // a regression here fails as "unsettled" instead of wedging this test (and, in production, the
  // run) indefinitely.
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
        // The SAME stream returned to every call, matching production's shared process.stdin —
        // NOT a fresh PassThrough per prompt, which is the divergence that hid this bug before.
        createInterface: () => createInterface({ input, output: new PassThrough() }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(answers).toEqual(["no", "no"]);
  }, 10_000);

  // readline's tty path calls close() on Ctrl-D at an empty line WITHOUT the underlying stream
  // ending — verified directly against Node's readline implementation (rl.close() fires 'close'
  // while input.readableEnded stays false). Simulated here by calling rl.close() directly, the
  // same effect Ctrl-D has, on a stream that is never `.end()`-ed. A regression that latches
  // `ended` on ANY 'close' (not just a real EOF) would deny the SECOND prompt too, with nothing
  // rendered, even though its own Interface is a fresh one on an unrelated stream.
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
        // A fresh stream per prompt, deliberately unlike the shared-stream test above: this test
        // is about the LATCH surviving a close that was not a real end, not about stream sharing.
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

  // Exercises makeApprovalPrompt directly (via the fake runLoop below), bypassing the real gate —
  // in production the gate means this toolName is always one of the fixed WRITE_TOOL_NAMES, never
  // model-invented (see escapeControlChars's own comment in output.ts for why). This pins the
  // escaping mechanism itself, kept as defence-in-depth for a future non-fixed write tool name: a
  // control character (here, ESC — the start of an ANSI sequence) could otherwise paint over the
  // real prompt or scroll it off-screen; escaped, it is inert text a user can read.
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

  // makeApprovalPrompt's own `offersAlways` widens to any mcp_-shaped name, not just
  // PERSISTABLE_TOOLS — without it, rememberGrant's fingerprinted MCP grant (permissions/store.ts)
  // is unreachable through this prompt, and an MCP tool would ask forever with no way to answer
  // "always". A built-in name still gets no such offer, in the same run, so this also proves the
  // widening did not just replace the PERSISTABLE_TOOLS check outright.
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

  // write_file's input carries the whole file body: an uncapped JSON.stringify would render a
  // 500-line generated module on one prompt line and scroll the question itself out of
  // scrollback before the user could even see it, let alone answer it.
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

  // JSON.stringify(undefined) returns the value undefined, not a string, and .length on that
  // throws — inside this Promise executor, which rejects approvalPrompt and escapes driveLoop as
  // an unhandled rejection, skipping printUsage and the exit-code logic entirely. Unreachable via
  // the real gate today (call.input is provider-parsed JSON), but ApprovalPrompt is an exported
  // seam Stage 11's Ink prompt re-implements against, and args: unknown promises nothing.
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

  // The allowlist is keyed on tool name alone, and approving one bash call because it looked like
  // `ls -la` would silently auto-approve `rm -rf ./src` under the same grant — see
  // PERSISTABLE_TOOL_NAMES's own comment in permissions/store.ts. bash and powershell never offer
  // "always" at all.
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

  // chooseInterfaceOutput is what the default (uninjected) Interface factory uses — every other
  // test in this file supplies its own createInterface and never exercises it, so this is the only
  // coverage of the TTY-symmetric selection itself. `| tee log` redirects stdout; `2> errors.log`
  // redirects stderr; neither, or both, redirected is the two-arg call's own fallback case.
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

  // The press this prompt has to catch never arrives as a process signal. Measured on a real pty
  // with all three candidate handlers registered while rl.question was up and one real 0x03 sent:
  // rl's SIGINT and close fired, process.on("SIGINT") did not — readline's raw mode stops the tty
  // generating the signal and delivers the byte as data. The test above drives the AbortSignal
  // directly, so it passes with nothing listening on the interface at all; this one drives the
  // interface, which is the wire that was missing when a real Ctrl-C at a real prompt killed the
  // process outright and left the session unresumable.
  //
  // "Cancelled" rather than "denied" is asserted as the cancel slot being spent, because both
  // answers are `"no"` — that is exactly how the loop tells them apart, by re-checking the signal.
  test("a SIGINT on the readline interface cancels through signals.ts instead of denying", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    let rl: Interface | undefined;

    let answer: ApprovalAnswer | "unsettled" | undefined;
    let cancelledBy: NodeJS.Signals | undefined;
    async function* runLoopFake(
      opts: RunLoopOpts,
    ): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      // The run's own cancel is displaced for the duration of the turn, deliberately: signals.ts
      // holds ONE slot, and letting cli.ts's own registration win would end this turn in
      // raiseSignal — the correct production behaviour, and a test process that kills the runner.
      // Observing the slot is also the assertion, since a prompt that re-implemented the cancel
      // rules locally instead of calling deliverSignal would never reach it.
      const parked = new AbortController();
      const unregister = onSignalCancel((signal) => {
        cancelledBy = signal;
        parked.abort();
      });
      try {
        // The executor runs synchronously, so the interface exists and its listener is attached by
        // the time the call returns — no wait to race with.
        const pending = opts.approvalPrompt?.("write_file", { path: "a.txt" }, parked.signal);
        rl?.emit("SIGINT");
        // Raced rather than awaited outright. Without the interface listener the prompt never
        // settles — that IS the defect — and a bare await turns this test's negative control into a
        // wedged runner instead of a red line. Measured: the whole chain from emit to resolve is
        // synchronous, so a settled promise always wins this race.
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
        // A real readline over a pair of pipes rather than a mock: emitting SIGINT on it is the
        // same call readline itself makes on a terminal, and nothing else about the interface is
        // being stood in for.
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
    // `done: "aborted"` reaching cli.ts's final `return` at all means the abort did not come
    // through cli.ts's own cancel slot, so raiseSignal never ran and the status below is what the
    // shell sees. Here that shape exists because this fake displaces the slot; in production it
    // would take a second caller of controller.abort(). Exit 1 is what that shape gets today, and
    // that is the whole of what this line records.
    //
    // It is NOT a guard against that second caller appearing — when Stage 6's subagents add one,
    // `done: "aborted"` becomes reachable there for real and this test stays green through the
    // change, because the value asserted here is the value such a change would have to alter to be
    // caught. Whoever adds an aborter has to decide for themselves whether a non-Ctrl-C abort
    // should still exit 1 and revisit this assertion; the suite will not raise it for them.
    expect(code).toBe(1);
  }, 10_000);

  // `✓ edit done` read as a completed file edit for a tool that returns text and writes nothing.
  // The write_file assertion is the control in the other direction: it goes red if the shared line
  // is changed instead of branched, which would make every tool claim it wrote nothing. Nothing
  // else in the suite pins the `✓ <tool> done` format, so this test becomes that pin.
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

  // The diagnostics half of the same line, and the reason the test above still passes: the count is
  // read off the RESULT'S SHAPE, not off the tool's name, so a result without one is unchanged.
  // The result here is what verify/wrapTools.ts actually returns.
  test("a write_file result carrying diagnostics says how many were fed back", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([
      {
        type: "tool-result",
        name: "write_file",
        // `satisfies CheckOutcome` is load-bearing: LoopEvent.result is `unknown` (loop.ts:17), so
        // without it this literal is checked against nothing and would keep passing against a
        // contract that had already changed underneath it.
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

  // The count a human reads must be the one the check reported, not the one that survived the
  // 20-diagnostic cap. Printing "20" for a 300-error build is the exact confusion `total` exists
  // to prevent, in the one place a person actually looks.
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

  // A broken check command — a typo in SERI_VERIFY_COMMAND — spawns a process on every write and
  // reports nothing to the user, who is paying for it. `failed` means the CHECK is broken, not
  // that the code is clean, so it must not be indistinguishable from a clean run.
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

  // The per-write cost is this feature's headline risk, and the person deciding whether to turn it
  // off cannot see it otherwise.
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

  // The other half of "a new event member must not fall through printEvent silently": the SDK has
  // been retrying a rejected call twice, 2 s apart, for as long as this repo has called it, and the
  // user saw a turn that had simply stopped. The attempt number is the whole payload — loop.ts's
  // event carries no error and no delay because the SDK's only per-attempt hook carries neither —
  // so it is the one thing this line has to get onto the screen.
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

  // Every field of LanguageModelUsage spelled out because the type requires all five, and only the
  // two the summary sums are given values: a helper that filled in the details would be asserting
  // on fields no line of cli.ts reads. Both are `number | undefined` in the SDK's own type — the
  // undefined case is a provider that did not report that half, and it is a case the summary has
  // to be able to say nothing about.
  // `cost` is optional and omitted by every caller except the printCost test below — passing it
  // through here rather than spreading the result keeps this typed as the `usage` member of
  // LoopEvent specifically, not the whole union (a spread widens to "some member plus an extra
  // property", which tsc rejects since only `usage` actually has a `cost` field).
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

  // One line for the whole run, not one per turn: the loop emits usage per completed model call by
  // design, and a twenty-turn task would otherwise print twenty rows nobody can add up. The
  // compacted event's usage is in the same total because the summariser's round-trip is billed like
  // any other — that is why loop.ts stopped dropping it.
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

  // "0 out" is a measurement, and there was no measurement: a provider that reports input tokens
  // and omits output ones is not a provider that measured zero output. The half that was reported
  // is still worth printing — dropping the whole line would throw away a real number to avoid an
  // invented one.
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

  // The other side of that line, and the reason it is keyed on undefined rather than on 0: a call
  // that really did report zero output tokens reported something, and the summary says so.
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

  // The reason the summary is conditional. Every other test in this file drives a fake that emits no
  // usage at all, and a run that made no model call has no spend to report — a "(tokens: 0 in, 0
  // out)" on the end of a run whose provider failed before the first request would be a number the
  // user could not act on and a new line on paths that never call the model.
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

  // Tokens spent before a failure are billed exactly like tokens spent before an answer, so the
  // summary belongs on the way out of every run that made a call — not inside the success branch.
  // The usage-then-error sequence below is one the real loop emits, not one only a fake can
  // produce: loop.ts reads the usage of a call that streamed and then failed before it returns
  // (loop.test.ts, "emits the usage of a call that streamed text and then failed mid-stream").
  // The cancelled run is the same decision and cannot be tested here: it ends in raiseSignal, which
  // would kill the test runner.
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

  // HIGH-1: driveLoop used to call runLoopFn with no provider/modelId/catalog at all, which is what
  // loop.ts's own cost branch (`opts.provider === "openrouter" ? … : opts.provider && opts.modelId
  // && opts.catalog ? … : undefined`) is gated on — so cost was silently never computed in
  // production, no matter what cost.ts itself did. This asserts the wiring, not the pricing math
  // (cost.test.ts already covers reportFromCatalogPricing/reportForOpenRouter directly).
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

  // The other half of HIGH-1: printCost had zero callers anywhere in src/ before this — a cost
  // computed by loop.ts never reached the terminal at all. Printed alongside the token summary,
  // same as printUsage, and only when the run actually reported one (cost.test.ts's own
  // "unknown"/undefined cases are what printCost itself does with those; this only checks the line
  // reaches the terminal at all).
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

  // captureLogs collects console.log's arguments, and a defect that is precisely a missing line
  // boundary cannot fail such an assertion: capturing per call, or trimming, or splitting on "\n"
  // all re-insert the boundary being asserted about. This reconstructs the byte stream instead —
  // console.log's newline included, and the model's own text, which goes out through
  // process.stdout.write and never reaches console.log at all.
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

  // The path the end-of-run summary was built for is the one where nothing else ends the line: a
  // call that streamed text and then failed prints its partial text with no trailing newline, the
  // error goes to stderr, and there is no `done` event to carry printEvent's leading "\n". Measured
  // before the fix, on raw stdout: "partial answer(tokens: 900 in, 7 out)\n" — a consumer piping
  // stdout for the model's answer got the token count welded onto its last line.
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

  // A provider failure exited 0, so `seri "…" && next-thing` ran next-thing on a turn that never
  // happened. The discriminator is the generator ending with no `done` event, which loop.ts's two
  // stream-error returns are the only exits to do.
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

  // A cap is not a finish: the run stopped because it ran out of iterations, with the user's task
  // unanswered, so `seri "big task" && deploy` must not deploy. `max-iterations` yields `done`, so
  // "the generator ended with no done event" alone would have exited 0 here.
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

  // Green before and after, deliberately: this is the negative control that the exit code is not
  // "any error event ⇒ 1". loop.ts yields `error` and carries on at three sites, and a run that
  // recovered from a failed tool call and then answered the user did not fail — observed live, a
  // session printed a read_file ENOENT and completed normally.
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

  // `run(["config", …])` had no test at all, on the one path that carries a secret. What a
  // fall-through here costs is not an unhandled subcommand: `config` reaching the task path mints a
  // session and persists `set GROQ_API_KEY gsk_live_…` — the user's key, in full — as the task text
  // in the session JSON. So the empty sessions dir is asserted alongside the exit code, which on
  // its own cannot tell "config list succeeded" from "config was never handled".
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

  // A task whose first word happens to name an Object.prototype member is an ordinary task, and it
  // has to reach the model. Looked up on an object literal, `SLASH_COMMANDS["toString"]` returned
  // Object.prototype.toString — a function, so it passed the dispatch guard, was called against the
  // most recent session, printed nothing and exited 0. The task silently never ran.
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

  // MEDIUM-D: a task whose first word happens to be /exit, followed by other words, is a task
  // regardless of whether /exit is registered in SLASH_COMMANDS at all — its own `accepts()`
  // (when it existed) already rejected trailing args, so this alone does not exercise MEDIUM-F's
  // fix. See the bare-word test below for that.
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

  // MEDIUM-F: /exit is deliberately not in SLASH_COMMANDS (it only means anything to a live TUI —
  // see the table's own comment in cli.ts) — before that fix, a BARE `seri /exit` (no trailing
  // args — the previous test's trailing-args case was already routed to the model by the old
  // entry's own `accepts()`, so it never actually exercised this) matched the table's no-op
  // entry: with no session (this test's own case, a fresh empty sessionsDir) it printed a
  // nonsense "No session to run /exit against" and exited 1, the fake runLoop never invoked at
  // all. Now it reaches the model as an ordinary task like any other.
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

// cli-tui-stage-b-bare-seri, feature-plan.md Stage B: covers the non-interactive path only — bare
// `seri` in a real TTY mounts the TUI instead (tests/tui/tuiPty.test.ts's own "bare seri" describe,
// skipIf win32). Every case here passes no `isTTY`, so it exercises exactly what every existing
// caller of `run()` in this file already gets: the positionals.length===0 gate's non-interactive
// behavior (USAGE / "No task given.") must stay byte-for-byte unchanged by Stage B's `&& !isTTY`
// addition to that gate.
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

  // The Stage B narrowing/negative-control tests below need a real, appended-to session on disk —
  // a fake that echoes `opts.messages` back through a `messages-updated` event, the same event
  // driveLoop's own persist callback writes to disk on, so the assertions read genuinely persisted
  // JSON rather than merely what was passed to runLoop.
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

  // Thermo-nuclear review finding: `ctx.taskText` used to be built as `positionals.join(" ")` with
  // no trim, so a whitespace-only task read as non-empty (the length check) while the push site's
  // OWN separate `.trim()` then persisted `content: ""` anyway — the exact empty-content message
  // this whole stage exists to prevent. Trimming once at construction (cli.ts) means `runStart`
  // treats a whitespace-only or empty-string positional the same as no task at all, so it never
  // reaches prepareSession — this asserts that on the strongest possible level: no session is ever
  // created, so there is nothing on disk for an empty-content message to appear in.
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
    // Unchanged from the assertion above: a bare `--continue` appends nothing new.
    expect(loadSession("abc", sessionsDir).messages).toEqual([
      { role: "user", content: "old task" },
      { role: "user", content: "new task" },
    ]);
  });

  // The non-interactive-path negative control matching tuiPty.test.ts's own bare-seri acceptance
  // test: `--resume <id>` with no task must not persist an empty-content user message. `--resume`
  // (unlike bare `seri`, which now mounts the TUI on a TTY) still reaches this same non-interactive
  // driveLoop path when isTTY is falsy, and this is the case the old, un-narrowed `hasNewTask`
  // (`!ctx.resuming || ...`) already handled correctly for --resume/--continue — this pins it as a
  // regression lock now that runStart replaces that predicate.
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

// byok-guided-setup, feature-plan.md: covers the exact predicate run()'s new isTTY-and-zero-keys
// gate depends on — configuredProviders(dir).size === 0 — not configuredProviders itself (already
// covered elsewhere). Every provider's own key env var is cleared for the duration so a real key
// already exported on the dev/CI box can never mask the "zero configured" case (code-quality.md's
// "the platform matrix does not cover the unset case").
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

  test("a hosted login with zero keys does not need guided setup", () => {
    // Isolates Codex's ambient ~/.codex/auth.json so this assertion is about auth.json
    // only, not a ChatGPT plan the machine happens to have connected.
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
  // The project key a new session actually runs under: projectRoot(session.cwd), and a new
  // session's cwd is process.cwd() (loadOrCreateSession).
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
    // Redirect the config dir to an empty temp dir, same guard as "run (task invocation)"'s
    // beforeEach: every run() call below passes permissionsDir explicitly, but checkpointsDir is
    // not overridden here and would otherwise resolve against this machine's real config dir.
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

  // 19. A stored grant reaches runLoop as the seed — the read half of Hermes #4739 at the
  // integration level. Negative control: deleting the loadGrants call in prepareSession.
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

  // 20. tool-allowed for write_file writes the file, and the run prints where it saved it.
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

  // 22. A grant survives into a later invocation — the deterministic twin of acceptance criterion
  // 1, which goes red if either the read or the write half is removed.
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

  // 24. The pre-approved line is printed in approve-each, and in no other mode: read-only never
  // consults the allowlist (the gate blocks first) and auto allows everything anyway, so printing
  // "pre-approved" in either would be a sentence the run does not honour.
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

  // 25. A store write failure warns and does not kill the run — mirrors the appendBarrier
  // degrade-never-fail policy at cli.ts's compaction-barrier call. A chmod on permissionsDir
  // itself does NOT reach this: writeDocument's own chmodSync(configDir, 0o700) (store.ts,
  // copying config.ts's upgrade-path behaviour) resets it before ever attempting the write — so
  // the failure is forced by colliding the path with a plain file instead, which makes
  // mkdirSync(configDir) fail with ENOTDIR regardless of ownership or mode.
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

  // Pins the hazard the --resume/--continue split introduces: --resume now takes a session id, so
  // `--resume /mode` would look for a session literally named "/mode". Guarded rather than left to
  // fail as "session not found": a slash-command name after --resume is a usage error that names
  // --continue as the fix.
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
    // An ordinary task before the dispatch table existed. /mode takes no arguments, so any
    // argument at all means this is not an invocation of it.
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
      // Deleted rather than reassigned when it was unset: `process.env.X = undefined` stores the
      // literal string "undefined" and pollutes every later test in the process.
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

  // A groq model with a real `effort` reasoning-options entry — the bundled fallback manifest
  // (catalog-manifest.json) predates this feature and carries no reasoning_options at all, so
  // these tests fetch a live-shaped catalog rather than relying on this file's other describe
  // blocks' own SERI_DISABLE_MODELS_FETCH=1/bundled-fallback convention.
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

  // fetchAccountPlan's own login guard skips its network call entirely when no auth session is
  // saved (this describe block never calls saveAuthSession), so a single unconditional mock is
  // safe here — unlike the gateway describe block above, nothing else this run touches ever hits
  // `fetch` for a different URL.
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

  // effortCommand's own resolveRoute() call must thread `plan`, or a
  // gateway-routed session lists tiers for the wrong route entirely. Fixture: "gateway-model" has
  // NO local groq/openrouter key configured, so it can only be reached via the gateway
  // (openrouter's own "groq/gateway-model" sibling, routing.ts's own route-key grouping) — and
  // that sibling's legal tiers differ from the groq-native entry's own. Without `plan` threaded,
  // resolveRoute's own gatewayCoverage check (routing.ts) always fails closed on a null plan, so
  // the route never reroutes at all and /effort lists the native entry's tiers — the wrong ones,
  // since the turn itself (prepareSession, which DOES thread plan) will actually route through the
  // gateway entry.
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

  // /effort's own SLASH_COMMANDS registration, mirroring "run (/clear)"'s own "is registered with
  // an exact, empty accepts, mutatesRunState, and scopeTargetToCwd" test.
  test("is registered with an at-most-one-argument accepts and mutatesRunState", () => {
    const effort = SLASH_COMMANDS.get("/effort");
    if (effort === undefined) throw new Error("/effort is not registered");
    expect(effort.accepts([])).toBe(true);
    expect(effort.accepts(["medium"])).toBe(true);
    expect(effort.accepts(["auto"])).toBe(true);
    expect(effort.accepts(["medium", "extra"])).toBe(false);
    // Inert on the TUI path today (its own onSubmit interception claims every /effort form before
    // this table is ever reached for it) but kept as insurance against this table's own `accepts`
    // above and that interception's matching guard drifting apart in a later change — this
    // entry's own comment, cli.ts, has the full account.
    expect(effort.mutatesRunState).toBe(true);
  });

  // Mirrors "`/clear the screen please` stays a task", above: /effort's own `accepts()` form caps
  // at one argument (SLASH_COMMANDS' own entry comment), so trailing garbage past `args[0]` must
  // fall through to the model as a task rather than being silently truncated by effortCommand.
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

  // /compact mutates the checkpoint store and truncates session.messages exactly like /undo,
  // /restore and /rewind — a mid-turn run would race the in-flight turn's own messages-updated the
  // same way (SlashCommand's own mutatesRunState comment). This is the field runTui's onSubmit
  // actually gates on to refuse it while a turn is in flight.
  test("/compact is registered with mutatesRunState so onSubmit refuses it mid-turn", () => {
    const compact = SLASH_COMMANDS.get("/compact");
    if (compact === undefined) throw new Error("/compact is not registered");
    expect(compact.mutatesRunState).toBe(true);
    expect(compact.accepts([])).toBe(true);
    expect(compact.accepts(["focus", "on", "the", "auth", "bug"])).toBe(true);
  });

  // Mirrors "`/mode is broken, fix it` stays a task", above: /clear's own accepts() form is the
  // same exact-and-empty shape as /mode's, so a trailing word (or a bare step count, which /rewind
  // would have accepted) must fall through to the model rather than being hijacked.
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
    // No --resume was given, so a task starts its own fresh session — the hijack guard being
    // tested here is that "clear-hijack-1" itself was never touched by /clear's own decision.
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

  // Exercises clearCommand directly through SLASH_COMMANDS, with a fake presenter that records
  // call order — the ordering clearCommand's own comment claims is load-bearing (persist before
  // wiping, wipe before the confirmation message).
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

  // Two checkpoints over one worktree: the first captures "before" at message anchor 1, the second
  // captures "after" at anchor 3, and the disk is left holding "final".
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
    // The case the printed git incantation got wrong. `read-tree` + `checkout-index -a -f` is
    // additive: it recreated new.ts and left old.ts sitting beside it, a state that had never
    // existed, under a line reading "To get it back". The assertion that discriminates is
    // old.ts being gone again, not new.ts coming back.
    const storeDir = checkpointStoreDir(checkpointsDir, workTree);
    writeFileSync(join(workTree, "old.ts"), "old\n");
    createCheckpointer({
      storeDir,
      worktree: workTree,
      sessionId: SESSION_ID,
      onWarning: () => {},
      cwd: workTree,
    })({ tool: "write_file", toolCallId: "c1", args: { path: "old.ts" }, rewindTo: 1 });
    // The agent's own write_file call, not a second checkpoint: recordWrite is what write_file's
    // onAfterMutation populates on every successful write, independent of whether a new snapshot
    // was taken. Both old.ts and new.ts need it — the removal pass, in both directions this test
    // exercises (the /undo below and the /restore that recovers from it), now requires this proof
    // before it will delete either.
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

    // Resolving to the most recent session and failing on the sha is the proof: taken as a session
    // id, "/restore" would have failed to load a session instead.
    await expect(slashCall("/restore", ["deadbeef"])).rejects.toThrow(
      /deadbeef is not a checkpoint/,
    );
  }, 15_000);

  test("a rewind invalidates the anchors recorded before it, instead of slicing into a rebuilt array", async () => {
    // The walkthrough, exactly: nine messages with anchors [1,3,5,7]; `/rewind 2` takes anchor 5
    // and truncates to five; the resume appends five more and records [6,8]. `/rewind 3` then used
    // to reach the stale anchor 7 — small enough to still land, so the clamp never saw it — and
    // slice to 7, leaving an assistant tool-call whose tool result had been dropped. That is
    // AI_MissingToolResultsError on the next resume, the exact failure `rewindTo = length - 1`
    // exists to prevent.
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

    // The resume: five more messages, and the two anchors that run would record against them.
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

    // A second, independent store rather than wiping and reusing this one: SESSION_ID is reused
    // across this suite, and mixing the two runs in one database would make the second pass
    // update the first run's rows instead of starting from the seed.
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
    // A previous /rewind can leave the session shorter than an anchor recorded before it. Slicing
    // past the end is a no-op, so reporting the anchor rather than the count would announce a
    // truncation that never happened.
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
    // The dispatch splits the task on whitespace and looks up token one, so this was claimed by
    // /undo and died in the step parser with the task never sent — the second regression out of
    // the same table, after the Object.prototype walk. The command forms are exact, so anything
    // outside them falls through to the model, which is the only direction that cannot swallow
    // work silently.
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
      // Deleted rather than reassigned when it was unset: `process.env.X = undefined` stores the
      // literal string "undefined" and pollutes every later test in the process.
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

  // Round 7 code review: the finding-9 fix from the previous round did not actually hold on the
  // TUI path — rewindCommand called recordBarrier() right after presenter.sessionUpdated(next),
  // on the strength of a comment claiming the truncation was "already persisted by this point,"
  // true on the non-interactive path (consolePresenter's own sessionUpdated calls saveSession
  // synchronously) but not on the TUI path (tuiPresenter's own sessionUpdated only dispatches;
  // the actual write is deferred to App.tsx's async effect). This test exercises rewindCommand
  // directly, through SLASH_COMMANDS, with a presenter whose sessionUpdated is a promise this
  // test controls — the same shape tuiPresenter's own now has, minus the reducer/effect
  // machinery, which is what makes the genuine await-ordering observable without a real TUI.
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

    // sessionUpdated's own promise is still pending — recordBarrier must not have run yet.
    expect(readLog(storeDir, SESSION_ID).some((r) => r.kind === "rewind-barrier")).toBe(false);

    resolveSessionUpdated?.();
    await done;

    expect(readLog(storeDir, SESSION_ID).some((r) => r.kind === "rewind-barrier")).toBe(true);
  }, 15_000);
});

// The doGenerate usage shape a real generateText call reports back (LanguageModelV4's own
// breakdown, not the normalized LanguageModelUsage compactMessages returns) — same shape
// compaction.test.ts's own `usage()` helper uses, restated here rather than imported since that
// file exports no such helper.
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
    // Cleared for the duration so a real key already exported on the dev/CI box can never make
    // resolveRoute reroute past the injected mock model to a real provider (code-quality.md's "the
    // platform matrix does not cover the unset case").
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
    // ~1000 tokens each so a 20-message tail is the 20_000-token keep.
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

  // appendBarrier (checkpoint.ts) is itself a no-op with no checkpoint log to protect — this seeds
  // an empty one so a compaction barrier actually gets appended and is observable, the same
  // precondition the /undo-and-/rewind describe block's own seed() establishes with a real
  // checkpointer (not needed here: /compact never reads a checkpoint snapshot, only the barrier).
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
    // 30 padded messages at ~1000 tokens each: keep 20_000 tokens ≈ last 20, evict 10.
    expect(logs).toContain("⚙ compacted 10 messages");
    expect(logs).toContain("\n(tokens: 20 in, 10 out)");

    const saved = loadSession<ModelMessage>(SESSION_ID, sessionsDir);
    expect(saved.messages).toHaveLength(21); // 1 summary + the 20 preserved tail messages
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

    // Negative control: a regression that always compacts would still print SOMETHING here and
    // would call the model — this is what makes that regression fail rather than pass silently.
    expect(doGenerateCalls).toBe(0);
    expect(logs).toEqual(["Not enough history to compact."]);
    expect(loadSession(SESSION_ID, sessionsDir)).toEqual(before);
    expect(readLog(checkpointStoreDir(checkpointsDir, worktree), SESSION_ID)).toEqual([]);
  });

  // Round-trips through the real SLASH_COMMANDS.get("/compact") entry with a doGenerate that hangs
  // until aborted — the abortable-mock fixture (compactionUsage's own abortable counterpart, just
  // above) that nothing else in the repo needed before /compact (EXPLORE: zero
  // AbortSignal/AbortController matches in compaction.test.ts/loop.test.ts).
  //
  // Presenter is a stub, not testPresenter: this test's assertion is on WHICH signal reached
  // `cancelled`, and testPresenter's own cancelled only logs a fixed string, exposing no way to
  // capture the argument it was called with.
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
            // Shaped the way a real aborted generateText call throws (name "AbortError"), not a
            // generic error — otherwise this test could pass for the wrong reason: compactCommand's
            // own catch only treats it as a cancellation because `controller.signal.aborted` is
            // true, not because of this error's shape, so asserting the shape here is what proves
            // the mock actually exercised an abort rather than any other rejection.
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
      // The real path this exercises: process.on("SIGINT") calls deliverSignal directly
      // (signals.ts) — this IS a Ctrl-C, not a stand-in for one. Safe to call unconditionally only
      // because `started` already resolved: compactCommand registers its onSignalCancel callback
      // (cli.ts) before calling compactMessages/generateText, the only path that reaches this
      // mock's doGenerate, so the slot is guaranteed populated here and deliverSignal's
      // process-killing fallback (nothing registered) is unreachable.
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

  // Rewritten from a prior version that fired a signal immediately after the run and then checked
  // a NEW registration fired — but deliverSignal (signals.ts) clears its slot BEFORE invoking the
  // callback, so that passed regardless of whether compactCommand's own finally ever ran; and
  // registering a new callback afterward would have passed just as trivially even without that
  // rewrite, since onSignalCancel unconditionally overwrites whatever is already in the slot
  // (signals.ts's own comment: one slot, last writer wins) — the assertion cannot tell a freed slot
  // from a stale one that way. The only way to actually observe whether the slot is free is to fire
  // a signal with NOTHING newly registered and check which of deliverSignal's two branches ran: a
  // stale handle takes the (silent, no-op) cancel branch, a freed slot falls through to the real,
  // nothing-to-cancel path, which re-raises the signal via `process.kill`. `process.kill` is stubbed
  // so that path is observable without actually ending this test process, and the process-level
  // SIGINT/SIGTERM listeners signals.ts installs at import time — removed by that same real path as
  // part of re-raising — are restored afterward so later tests still get them.
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

  // Regression for the race CommandPresenter's own `currentSession` comment describes: /mode is
  // deliberately exempt from `turnInFlight` gating (SlashCommand's own comment on why), so it can
  // run while /compact's own two awaits (the catalog/plan fetch, the summarizer round trip) are
  // still in flight. This presenter's `currentSession` returns a DIFFERENT permissionMode than the
  // `session` passed to `run` — standing in for a /mode dispatch that landed mid-compact — and
  // asserts the final `sessionUpdated` call carries that live value forward instead of the stale
  // `permissionMode` compactCommand's own `session` parameter still holds.
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
      // Stands in for /mode having already dispatched into live TUI state while /compact awaited.
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

// The onSubmit call sites both build their fold callback inline (cli.ts: `tuiPresenter(dispatch,
// awaitNextPersist, () => liveState.session, (u) => { usage = {...} })`) — this exercises
// tuiPresenter's own contract that `usageAccrued` is exactly the fourth argument, unmodified, so a
// future edit that drops the fold or wires it to the wrong variable at either call site fails here
// rather than only being observable through a live /compact run in the TUI.
describe("tuiPresenter", () => {
  test("usageAccrued calls the supplied fold with the usage it was given", () => {
    const received: LanguageModelUsage[] = [];
    // getSession is never called in this test — usageAccrued is the only thing exercised.
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

  // VERIFY pass 2, HIGH-2: taking the most recent report's status unconditionally let an "actual"
  // turn mask an earlier "estimated"/"unknown" turn in the running total — a partially-uncertain
  // total must not present as fully certain.
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
    // addTokens keeps the running total when the new report has no amount to add — the $0.002
    // already earned is not thrown away, only the certainty label is downgraded.
    expect(combined?.amountUsd).toBeCloseTo(0.002, 6);
  });

  test("actual then unknown: degrades all the way to unknown even from the strongest status", () => {
    const combined = addCost(actual, unknown);
    expect(combined?.status).toBe("unknown");
  });
});
