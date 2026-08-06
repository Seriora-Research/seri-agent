import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { PassThrough } from "node:stream";
import type { ModelMessage } from "ai";
import pkg from "../../package.json";
import { checkpointStoreDir, createCheckpointer } from "../../src/checkpoint/checkpoint";
import { isGitAvailable } from "../../src/checkpoint/shadowGit";
import { run, SLASH_COMMANDS } from "../../src/cli";
import type { LoopEvent, runLoop } from "../../src/loop/loop";
import { toolDefinitions } from "../../src/provider/tools";
import { onSignalCancel } from "../../src/signals";
import { loadSession, saveSession, type SessionState } from "../../src/session/session";

describe("run", () => {
  test("--version prints the package.json version and returns 0", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    const code = await run(["--version"]);

    console.log = originalLog;
    expect(code).toBe(0);
    expect(logs).toEqual([`seri ${pkg.version}`]);
  });
});

describe("run (--selftest)", () => {
  test("returns 0 and reports success when grep runs", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));

    let code: number;
    try {
      code = await run(["--selftest"], {
        grep: async () => ({
          mode: "content" as const,
          matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
          truncated: false,
        }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(code).toBe(0);
    // Matched rather than compared: the vendored rg's version moves when it is re-vendored, and
    // pinning it here would fail the build for a reason that has nothing to do with the CLI. What
    // has to hold is that the line names a version and the mode that produced it.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^selftest ok: ripgrep \d+\.\d+\.\d+$/);
  });

  test("returns 1 and logs the error when grep throws", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));

    let code: number;
    try {
      code = await run(["--selftest"], {
        grep: async () => {
          throw new Error("ripgrep failed: Exec format error");
        },
      });
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(1);
    expect(errors).toEqual(["ripgrep failed: Exec format error"]);
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

  // The save/stub/try/finally/restore block the tests below repeated verbatim. `console.error` is
  // silenced rather than collected because none of them asserts on it — the ones that reach it (a
  // provider error, a run stopped at a cap) only ever needed it kept out of the test output. A
  // test that wants to assert on stderr stubs it itself, as the two that do already have.
  async function captureLogs(invoke: () => Promise<number>): Promise<{ code: number; logs: string[] }> {
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

  // `--help` matched nothing in cli.ts, so it fell through to the task path and was sent to the
  // model as the user message: a session file on disk and a full turn burned (5 tool calls,
  // observed live) to answer a request for the usage text. The key has to be set, or getGroqModel
  // throws before saveSession and the last two assertions would pass for the wrong reason.
  test.each(["--help", "-h"])("%p prints usage without creating a session or calling the model", async (flag) => {
    process.env.GROQ_API_KEY = "fake-test-key";

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let called = false;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      called = true;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const { code, logs } = await captureLogs(() =>
      run([flag], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(0);
    const usage = logs.join("\n");
    expect(usage).toContain("Usage:");
    // The usage text restates the SLASH_COMMANDS table, whose whole point is that a command is
    // defined in one place. `toContain("Usage:")` alone let every advertised line be deleted, so
    // the half of the text that has a table behind it is checked against the table.
    for (const name of SLASH_COMMANDS.keys()) expect(usage).toContain(name);
    expect(called).toBe(false);
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  // The defect above, one argument away: gating on argv.length meant `seri -h config` was not "the
  // whole invocation", so it fell through to the task path and wrote a session file and billed a
  // real turn to answer a request for the usage text. Under parseArgs a flag is a flag in any
  // position, so this form prints usage without ever reaching the task path — and so do `seri
  // --help --resume` and `seri --version --quiet`, both usage errors now rather than a route to
  // the task path at all.
  test.each(["--help", "-h"])("%p followed by another argument still prints usage", async (flag) => {
    process.env.GROQ_API_KEY = "fake-test-key";

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let called = false;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      called = true;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const { code, logs } = await captureLogs(() =>
      run([flag, "config"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
    expect(called).toBe(false);
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  // Inverts the pre-parseArgs behaviour: under parseArgs a flag anywhere in argv is a flag, so
  // `seri fix the --help output` now prints usage and never reaches the model — measured on the
  // compiled binary that `claude fix the --help output` behaves the same way. `--` is the
  // documented escape for a task that contains what looks like a flag, exercised in the same test
  // so it never needs a third copy of this fake.
  test.each(["--help", "-h"])("a task containing %p prints usage instead of reaching the model; -- escapes it", async (flag) => {
    process.env.GROQ_API_KEY = "fake-test-key";

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let called = false;
    let captured: RunLoopOpts | undefined;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      called = true;
      captured = opts;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const { code, logs } = await captureLogs(() =>
      run(["fix", "the", flag, "output"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
    expect(called).toBe(false);
    expect(readdirSync(sessionsDir)).toEqual([]);

    await captureLogs(() =>
      run(["--", "fix", "the", flag, "output"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(called).toBe(true);
    expect(captured?.messages.at(-1)).toEqual({ role: "user", content: `fix the ${flag} output` });
  });

  // The same inversion for the third flag: `seri fix the --selftest flag` now runs the
  // build-verification selftest and never reaches the model; `--` escapes it the same way.
  test("a task containing --selftest runs the selftest instead of reaching the model; -- escapes it", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let called = false;
    let captured: RunLoopOpts | undefined;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      called = true;
      captured = opts;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }
    const grepFn = async () => ({
      mode: "content" as const,
      matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
      truncated: false,
    });

    const { logs } = await captureLogs(() =>
      run(["fix", "the", "--selftest", "flag"], {
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
        sessionsDir,
        grep: grepFn,
      }),
    );

    expect(called).toBe(false);
    expect(logs.join("\n")).toContain("selftest ok");

    await captureLogs(() =>
      run(["--", "fix", "the", "--selftest", "flag"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir, grep: grepFn }),
    );

    expect(called).toBe(true);
    expect(captured?.messages.at(-1)).toEqual({ role: "user", content: "fix the --selftest flag" });
  });

  test("bare seri prints usage instead of exiting silently", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let called = false;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      called = true;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const { code, logs } = await captureLogs(() =>
      run([], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
    // Same two guards as the --help case above: with the key set, a fall-through to the task path
    // would call the model and write a session file rather than failing at getGroqModel.
    expect(called).toBe(false);
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  // The hole PR #27 left open: `--resume` used to take an optional value, so `--help` after it was
  // rejected as a session id (leading dash) and joined into the task instead — the most recent
  // session resumed and a turn was billed to answer a request for the usage text. `--resume` now
  // takes a mandatory value, and parseArgs itself throws on this shape (measured) before any of our
  // code runs, so no case here is written for it beyond routing the throw to exit 2.
  test("`--resume --help` is a usage error, not a resumed session and a billed turn", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let called = false;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      called = true;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    let code: number;
    try {
      code = await run(["--resume", "--help"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir });
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(readdirSync(sessionsDir)).toEqual([]);
    expect(errors.join("\n")).toContain("--");
  });

  test("`--bogus` names the -- escape and exits 2", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    let code: number;
    try {
      code = await run(["--bogus"], { loadAgentsFile: () => "", sessionsDir });
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(2);
    const stderr = errors.join("\n");
    expect(stderr).toContain("Unknown option");
    expect(stderr).toMatch(/--/);
  });

  test("`--continue` with no task resumes the most recent session without appending a message", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const older: SessionState = { id: "older", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [{ role: "user", content: "old task" }] };
    const newer: SessionState = { id: "newer", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [{ role: "user", content: "new task" }] };
    saveSession(older, sessionsDir);
    saveSession(newer, sessionsDir);
    const base = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(sessionsDir, "older.json"), base, base);
    utimesSync(join(sessionsDir, "newer.json"), new Date(base.getTime() + 60_000), new Date(base.getTime() + 60_000));

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let captured: RunLoopOpts | undefined;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      captured = opts;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    await captureLogs(() => run(["--continue"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }));

    expect(captured?.messages).toEqual([{ role: "user", content: "new task" }]);
    expect(readdirSync(sessionsDir)).toHaveLength(2);
  });

  // The negative control that splitting --resume into --resume <id> / --continue did not break the
  // surviving half: this passes on `main` too.
  test("`--resume <id>` resumes that session, not the most recent one", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const older: SessionState = { id: "older", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [{ role: "user", content: "old task" }] };
    const newer: SessionState = { id: "newer", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [{ role: "user", content: "new task" }] };
    saveSession(older, sessionsDir);
    saveSession(newer, sessionsDir);
    const base = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(sessionsDir, "older.json"), base, base);
    utimesSync(join(sessionsDir, "newer.json"), new Date(base.getTime() + 60_000), new Date(base.getTime() + 60_000));

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let captured: RunLoopOpts | undefined;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      captured = opts;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    await captureLogs(() =>
      run(["--resume", "older"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(captured?.messages).toEqual([{ role: "user", content: "old task" }]);
  });

  test("`--max-turns 3` reaches runLoop as maxIterations", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let captured: RunLoopOpts | undefined;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      captured = opts;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    await captureLogs(() =>
      run(["--max-turns", "3", "do", "a", "task"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(captured?.maxIterations).toBe(3);
  });

  // parseArgs accepts `--max-turns abc` happily (measured) — it has no numeric option type — so
  // this validation is not redundant with the parser's own checks.
  test.each(["0", "abc"])("`--max-turns %s` is a usage error", async (value) => {
    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let called = false;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      called = true;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const { code } = await captureLogs(() =>
      run(["--max-turns", value, "do", "a", "task"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  test("`--max-turns` with no value is a usage error", async () => {
    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let called = false;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      called = true;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const { code } = await captureLogs(() =>
      run(["--max-turns"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  test("flags but no task is a usage error", async () => {
    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let called = false;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      called = true;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const { code } = await captureLogs(() =>
      run(["--max-turns", "5"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(readdirSync(sessionsDir)).toEqual([]);
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
    // The same tool set, with only the filesystem-mutating tools wrapped for checkpointing.
    expect(Object.keys(captured?.tools ?? {})).toEqual(Object.keys(toolDefinitions));
    expect(captured?.tools.read_file).toBe(toolDefinitions.read_file);
    expect(captured?.tools.edit).toBe(toolDefinitions.edit);
    expect(captured?.tools.write_file).not.toBe(toolDefinitions.write_file);
    expect(captured?.messages.at(-1)).toEqual({ role: "user", content: "write hello.txt" });
    expect(captured?.messages).toHaveLength(1);
    expect(captured?.system).toBe("You are seri, a coding agent.");
  });

  // cli.ts is the only thing that constructs the controller — runLoop is a library that is handed a
  // signal and never makes one — so if this stops arriving, every abort check downstream (the
  // streamText round-trip, the compaction round-trip, the per-tool guard, spawnCollect, runRipgrep)
  // is dead code that keeps passing its own tests.
  test("hands runLoop a live AbortSignal", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let captured: RunLoopOpts | undefined;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      captured = opts;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir });
    } finally {
      console.log = originalLog;
    }

    expect(captured?.signal).toBeInstanceOf(AbortSignal);
    expect(captured?.signal?.aborted).toBe(false);
  });

  // The prompt is where a cancel is easiest to lose: the loop is parked in rl.question when Ctrl-C
  // arrives, and a readline nobody closes never settles, so the turn would hang until the user
  // pressed again — which kills the process before the tool row is written and leaves the session
  // unresumable. Exercised through the prompt runLoop is actually given, because makeApprovalPrompt
  // is not exported and the wiring is half of what is being asserted.
  test("the approval prompt it gives runLoop resolves false on abort instead of hanging", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    const answers: (boolean | undefined)[] = [];
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      // Aborted while the prompt is already open, which is the real sequence, and then aborted
      // before it is opened at all — an already-aborted signal fires no abort event, so a listener
      // on its own would wait forever for something that has already happened.
      const parked = new AbortController();
      const pending = opts.approvalPrompt?.("write_file", { path: "a.txt" }, parked.signal);
      parked.abort();
      answers.push(await pending);

      answers.push(await opts.approvalPrompt?.("write_file", { path: "b.txt" }, AbortSignal.abort()));
      yield { type: "done", reason: "aborted" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["write", "hello.txt"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir });
    } finally {
      console.log = originalLog;
    }

    expect(answers).toEqual([false, false]);
  }, 10_000);

  // The press this prompt has to catch never arrives as a process signal. Measured on a real pty
  // with all three candidate handlers registered while rl.question was up and one real 0x03 sent:
  // rl's SIGINT and close fired, process.on("SIGINT") did not — readline's raw mode stops the tty
  // generating the signal and delivers the byte as data. The test above drives the AbortSignal
  // directly, so it passes with nothing listening on the interface at all; this one drives the
  // interface, which is the wire that was missing when a real Ctrl-C at a real prompt killed the
  // process outright and left the session unresumable.
  //
  // "Cancelled" rather than "denied" is asserted as the cancel slot being spent, because both
  // answers are `false` — that is exactly how the loop tells them apart, by re-checking the signal.
  test("a SIGINT on the readline interface cancels through signals.ts instead of denying", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    let rl: Interface | undefined;

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let answer: boolean | "unsettled" | undefined;
    let cancelledBy: NodeJS.Signals | undefined;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
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
        answer = await Promise.race([pending, new Promise<"unsettled">((r) => setTimeout(() => r("unsettled"), 1000))]);
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
    expect(answer).toBe(false);
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

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      yield { type: "tool-result", name: "edit", result: "edited text" };
      yield { type: "tool-result", name: "write_file", result: "ok" };
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const { logs } = await captureLogs(() =>
      run(["edit", "a.txt"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(logs.join("\n")).toContain("nothing written");
    expect(logs.join("\n")).toContain("✓ write_file done");
  });

  // A provider failure exited 0, so `seri "…" && next-thing` ran next-thing on a turn that never
  // happened. The discriminator is the generator ending with no `done` event, which loop.ts's two
  // stream-error returns are the only exits to do.
  test("a run that ends without a done event exits non-zero", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    async function* runLoopFake(): AsyncGenerator<LoopEvent> {
      yield { type: "error", error: "AI_APICallError: Invalid API Key" };
    }

    const { code } = await captureLogs(() =>
      run(["say", "hi"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(1);
  });

  // A cap is not a finish: the run stopped because it ran out of iterations, with the user's task
  // unanswered, so `seri "big task" && deploy` must not deploy. `max-iterations` yields `done`, so
  // "the generator ended with no done event" alone would have exited 0 here.
  test("a run that stopped at max-iterations exits non-zero", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    async function* runLoopFake(): AsyncGenerator<LoopEvent> {
      yield { type: "done", reason: "max-iterations" };
    }

    const { code } = await captureLogs(() =>
      run(["say", "hi"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(1);
  });

  // Green before and after, deliberately: this is the negative control that the exit code is not
  // "any error event ⇒ 1". loop.ts yields `error` and carries on at three sites, and a run that
  // recovered from a failed tool call and then answered the user did not fail — observed live, a
  // session printed a read_file ENOENT and completed normally.
  test("a run that recovered from a tool error still exits 0", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    async function* runLoopFake(): AsyncGenerator<LoopEvent> {
      yield { type: "error", error: 'Tool "read_file" threw during execution: Error: ENOENT' };
      yield { type: "done", reason: "no-tool-call" };
    }

    const { code } = await captureLogs(() =>
      run(["say", "hi"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(0);
  });

  // A task whose first word happens to name an Object.prototype member is an ordinary task, and it
  // has to reach the model. Looked up on an object literal, `SLASH_COMMANDS["toString"]` returned
  // Object.prototype.toString — a function, so it passed the dispatch guard, was called against the
  // most recent session, printed nothing and exited 0. The task silently never ran.
  test.each(["toString", "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"])(
    "a task starting with %p is sent to the model, not dispatched as a slash command",
    async (word) => {
      process.env.GROQ_API_KEY = "fake-test-key";
      const existing: SessionState = { id: "proto", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [] };
      saveSession(existing, sessionsDir);

      type RunLoopOpts = Parameters<typeof runLoop>[0];
      let captured: RunLoopOpts | undefined;
      async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
        captured = opts;
        yield { type: "done", reason: "no-tool-call" };
        return opts.messages;
      }

      const originalLog = console.log;
      console.log = () => {};
      let code: number;
      try {
        code = await run([word, "is", "wrong", "on", "User"], { runLoop: runLoopFake, loadAgentsFile: () => "", sessionsDir });
      } finally {
        console.log = originalLog;
      }

      expect(code).toBe(0);
      expect(captured?.messages.at(-1)).toEqual({ role: "user", content: `${word} is wrong on User` });
    },
  );
});

describe("run (login/signup/logout)", () => {
  const failIfCalled = (name: string) => () => {
    throw new Error(`${name} should not be called`);
  };

  test("`seri login` calls deps.login with mode 'login' and never touches the model/loop/session code", async () => {
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

  test("`seri signup` calls deps.login with mode 'signup'", async () => {
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

  test("`seri logout` calls deps.logout and never touches the model/loop/session code", async () => {
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

  // Validated right after the parse (cli.ts), before any subcommand dispatch: `--max-turns garbage
  // login` used to reach login with the malformed flag silently ignored, while the same flag on a
  // task correctly exited 2.
  test("`seri --max-turns garbage login` is a usage error; login is never reached", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    let code: number;
    try {
      code = await run(["--max-turns", "garbage", "login"], {
        login: failIfCalled("login"),
        authConfigDir: "fake-config-dir",
        getGroqModel: failIfCalled("getGroqModel"),
        loadAgentsFile: failIfCalled("loadAgentsFile"),
      });
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("--max-turns");
  });
});

describe("run (/mode)", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-mode-sessions-"));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  test("`--continue /mode` cycles the most-recent session's mode", async () => {
    const existing: SessionState = { id: "abc", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [] };
    saveSession(existing, sessionsDir);

    const code = await run(["--continue", "/mode"], { sessionsDir });

    expect(code).toBe(0);
    expect(readdirSync(sessionsDir)).toHaveLength(1);
    expect(loadSession("abc", sessionsDir).permissionMode).toBe("approve-each");
  });

  // Pins the hazard the --resume/--continue split introduces in place of the misparse defect the
  // test above used to guard: --resume now takes a session id, so `--resume /mode` would look for
  // a session literally named "/mode" instead of cycling the most recent one. Guarded rather than
  // left to fail as "session not found": a slash-command name after --resume is a usage error that
  // names --continue as the fix.
  test("`--resume /mode` is a usage error naming --continue, not a session-not-found lookup", async () => {
    const existing: SessionState = { id: "abc", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [] };
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
    const existing: SessionState = { id: "ghi", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [] };
    saveSession(existing, sessionsDir);

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let captured: RunLoopOpts | undefined;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      captured = opts;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["/mode", "is", "broken,", "fix", "it"], { sessionsDir, runLoop: runLoopFake, loadAgentsFile: () => "" });
    } finally {
      console.log = originalLog;
      // Deleted rather than reassigned when it was unset: `process.env.X = undefined` stores the
      // literal string "undefined" and pollutes every later test in the process.
      if (originalKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalKey;
    }

    expect(captured?.messages.at(-1)).toEqual({ role: "user", content: "/mode is broken, fix it" });
    expect(loadSession("ghi", sessionsDir).permissionMode).toBe("read-only");
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

describe.skipIf(!isGitAvailable())("run (/undo and /rewind)", () => {
  const SESSION_ID = "ckpt";
  const messages: ModelMessage[] = [
    { role: "user", content: "one" },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
    { role: "user", content: "two" },
    { role: "assistant", content: [{ type: "text", text: "b" }] },
  ];

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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "seri-cli-checkpoint-"));
    sessionsDir = join(root, "sessions");
    checkpointsDir = join(root, "checkpoints");
    workTree = join(root, "work");
    mkdirSync(workTree, { recursive: true });
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
    rmSync(root, { recursive: true, force: true });
  });

  test("`--continue /undo` dispatches against the most-recent session", async () => {
    seed();

    const code = await run(["--continue", "/undo", "2"], { sessionsDir, checkpointsDir });

    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("before\n");
  }, 15_000);

  test("`--continue /rewind` dispatches against the most-recent session", async () => {
    seed();

    const code = await run(["--continue", "/rewind"], { sessionsDir, checkpointsDir });

    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages).toHaveLength(3);
  }, 15_000);

  test("/undo reports the diff, the restored path and the command that recovers what it replaced", async () => {
    seed();

    await run(["--resume", SESSION_ID, "/undo", "2"], { sessionsDir, checkpointsDir });

    expect(logs.join("\n")).toContain("restored a.txt");
    expect(logs.join("\n")).toMatch(/The state this replaced is commit [0-9a-f]{40}\./);
    expect(logs.join("\n")).toMatch(new RegExp(`seri --resume ${SESSION_ID} /restore [0-9a-f]{40}`));
  }, 15_000);

  test("the recovery command /undo prints puts back exactly the state it replaced", async () => {
    // The case the printed git incantation got wrong. `read-tree` + `checkout-index -a -f` is
    // additive: it recreated new.ts and left old.ts sitting beside it, a state that had never
    // existed, under a line reading "To get it back". The assertion that discriminates is
    // old.ts being gone again, not new.ts coming back.
    writeFileSync(join(workTree, "old.ts"), "old\n");
    createCheckpointer({
      storeDir: checkpointStoreDir(checkpointsDir, workTree),
      worktree: workTree,
      sessionId: SESSION_ID,
      onWarning: () => {},
    })({ tool: "write_file", toolCallId: "c1", args: { path: "old.ts" }, rewindTo: 1 });
    rmSync(join(workTree, "old.ts"));
    writeFileSync(join(workTree, "new.ts"), "new\n");
    saveSession({ id: SESSION_ID, cwd: workTree, systemPrompt: "", permissionMode: "auto", messages }, sessionsDir);

    await run(["--resume", SESSION_ID, "/undo"], { sessionsDir, checkpointsDir });
    expect(existsSync(join(workTree, "old.ts"))).toBe(true);
    expect(existsSync(join(workTree, "new.ts"))).toBe(false);

    const recovery = logs.join("\n").match(/seri --resume \S+ (\/restore [0-9a-f]{40})/)?.[1] ?? "";
    const code = await run(["--resume", SESSION_ID, ...recovery.split(" ")], { sessionsDir, checkpointsDir });

    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(existsSync(join(workTree, "old.ts"))).toBe(false);
    expect(readFileSync(join(workTree, "new.ts"), "utf8")).toBe("new\n");
  }, 20_000);

  test("`--continue /restore <sha>` dispatches against the most-recent session", async () => {
    seed();

    // Resolving to the most recent session and failing on the sha is the proof: taken as a session
    // id, "/restore" would have failed to load a session instead.
    const code = await run(["--continue", "/restore", "deadbeef"], { sessionsDir, checkpointsDir });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("deadbeef is not a checkpoint");
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
      snapshot({ tool: "write_file", toolCallId: `c${rewindTo}`, args: { path: join(workTree, "a.txt") }, rewindTo });
    for (const anchor of [1, 3, 5, 7]) record(anchor);
    saveSession({ id: SESSION_ID, cwd: workTree, systemPrompt: "", permissionMode: "auto", messages: nine }, sessionsDir);

    await run(["--resume", SESSION_ID, "/rewind", "2"], { sessionsDir, checkpointsDir });
    expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages).toHaveLength(5);

    // The resume: five more messages, and the two anchors that run would record against them.
    const resumed = loadSession<ModelMessage>(SESSION_ID, sessionsDir);
    resumed.messages = [...resumed.messages, ...nine.slice(0, 5)];
    saveSession(resumed, sessionsDir);
    for (const anchor of [6, 8]) record(anchor);

    const code = await run(["--resume", SESSION_ID, "/rewind", "3"], { sessionsDir, checkpointsDir });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("since the last rewind");
    expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages).toHaveLength(10);
  }, 30_000);

  test("/rewind truncates the conversation and leaves the filesystem byte-identical", async () => {
    seed();
    const before = readFileSync(join(workTree, "a.txt"));

    const code = await run(["--resume", SESSION_ID, "/rewind", "2"], { sessionsDir, checkpointsDir });

    expect(code).toBe(0);
    expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages).toEqual(messages.slice(0, 1));
    expect(readFileSync(join(workTree, "a.txt")).equals(before)).toBe(true);
  }, 15_000);

  test("/undo then /rewind lands on the same anchor as /rewind then /undo", async () => {
    seed();
    await run(["--resume", SESSION_ID, "/undo", "2"], { sessionsDir, checkpointsDir });
    await run(["--resume", SESSION_ID, "/rewind", "2"], { sessionsDir, checkpointsDir });
    const undoFirst = {
      file: readFileSync(join(workTree, "a.txt"), "utf8"),
      messages: loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages,
    };

    rmSync(root, { recursive: true, force: true });
    mkdirSync(workTree, { recursive: true });
    seed();
    await run(["--resume", SESSION_ID, "/rewind", "2"], { sessionsDir, checkpointsDir });
    await run(["--resume", SESSION_ID, "/undo", "2"], { sessionsDir, checkpointsDir });

    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe(undoFirst.file);
    expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages).toEqual(undoFirst.messages);
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
    })({ tool: "write_file", toolCallId: "c1", args: { path: "a.txt" }, rewindTo: 9 });
    saveSession(
      { id: SESSION_ID, cwd: workTree, systemPrompt: "", permissionMode: "auto", messages: messages.slice(0, 2) },
      sessionsDir,
    );

    const code = await run(["--resume", SESSION_ID, "/rewind"], { sessionsDir, checkpointsDir });

    expect(code).toBe(0);
    expect(loadSession<ModelMessage>(SESSION_ID, sessionsDir).messages).toHaveLength(2);
    expect(logs.join("\n")).toContain("dropped 0 message(s), 2 remain");
  }, 30_000);

  test("a repeated /undo says nothing changed instead of reporting a second undo", async () => {
    seed();

    await run(["--resume", SESSION_ID, "/undo"], { sessionsDir, checkpointsDir });
    logs.length = 0;
    const code = await run(["--resume", SESSION_ID, "/undo"], { sessionsDir, checkpointsDir });

    expect(code).toBe(0);
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

    type RunLoopOpts = Parameters<typeof runLoop>[0];
    let captured: RunLoopOpts | undefined;
    async function* runLoopFake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
      captured = opts;
      yield { type: "done", reason: "no-tool-call" };
      return opts.messages;
    }

    let code: number;
    try {
      code = await run(["--resume", SESSION_ID, "/undo", "the", "rename", "and", "try", "again"], {
        sessionsDir,
        checkpointsDir,
        runLoop: runLoopFake,
        loadAgentsFile: () => "",
      });
    } finally {
      // Deleted rather than reassigned when it was unset: `process.env.X = undefined` stores the
      // literal string "undefined" and pollutes every later test in the process.
      if (originalKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalKey;
    }

    expect(code).toBe(0);
    expect(captured?.messages.at(-1)).toEqual({ role: "user", content: "/undo the rename and try again" });
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("final\n");
  }, 20_000);
});
