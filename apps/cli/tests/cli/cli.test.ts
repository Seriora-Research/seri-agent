import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { PassThrough } from "node:stream";
import type { ModelMessage } from "ai";
import { buildSystemPrompt } from "../../src/agents/systemPrompt";
import { checkpointStoreDir, createCheckpointer } from "../../src/checkpoint/checkpoint";
import { isGitAvailable } from "../../src/checkpoint/shadowGit";
import { run } from "../../src/cli";
import type { LoopEvent, runLoop } from "../../src/loop/loop";
import { getGroqModel } from "../../src/provider/groq";
import { toolDefinitions } from "../../src/provider/tools";
import { onSignalCancel } from "../../src/signals";
import { loadSession, saveSession, type SessionState } from "../../src/session/session";
import type { CheckOutcome } from "../../src/verify/run";
import { fakeRunLoop } from "./fakeRunLoop";

type RunLoopOpts = Parameters<typeof runLoop>[0];

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

  test("`--continue` with no task resumes the most recent session without appending a message", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const older: SessionState = { id: "older", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [{ role: "user", content: "old task" }] };
    const newer: SessionState = { id: "newer", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [{ role: "user", content: "new task" }] };
    saveSession(older, sessionsDir);
    saveSession(newer, sessionsDir);
    const base = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(sessionsDir, "older.json"), base, base);
    utimesSync(join(sessionsDir, "newer.json"), new Date(base.getTime() + 60_000), new Date(base.getTime() + 60_000));

    const { fake, capture } = fakeRunLoop();

    await captureLogs(() => run(["--continue"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }));

    expect(capture()?.messages).toEqual([{ role: "user", content: "new task" }]);
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

    const { fake, capture } = fakeRunLoop();

    await captureLogs(() =>
      run(["--resume", "older"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
        sessionsDir,
      });
    } finally {
      console.log = originalLog;
    }

    expect(code).toBe(0);
    expect(capture()).toBeDefined();
    expect(capture()?.permissionMode).toBe("read-only");
    // The same tool set, with only the filesystem-mutating tools wrapped for checkpointing.
    expect(Object.keys(capture()?.tools ?? {})).toEqual(Object.keys(toolDefinitions));
    expect(capture()?.tools.read_file).toBe(toolDefinitions.read_file);
    expect(capture()?.tools.grep).toBe(toolDefinitions.grep);
    expect(capture()?.tools.glob).toBe(toolDefinitions.glob);
    expect(capture()?.tools.edit).toBe(toolDefinitions.edit);
    expect(capture()?.tools.write_file).not.toBe(toolDefinitions.write_file);
    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "write hello.txt" });
    expect(capture()?.messages).toHaveLength(1);
    // The assembled prompt, not the bare identity line: with no AGENTS.md this used to be 29
    // characters of identity and no tool guidance at all.
    expect(capture()?.system).toBe(buildSystemPrompt(""));
  });

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
      runLoop: fakeRunLoop().fake,
      loadAgentsFile: () => "",
      sessionsDir,
      getGroqModel: (id: string) => {
        asked.push(id);
        return getGroqModel("openai/gpt-oss-120b");
      },
    };

    try {
      const fresh = await captureLogs(() => run(["a", "task"], deps));
      expect(fresh.code).toBe(0);
      const created = loadSession(readdirSync(sessionsDir)[0]!.replace(/\.json$/, ""), sessionsDir);
      expect(created.model).toBe("model-from-env");
      expect(asked).toEqual(["model-from-env"]);

      const pinned: SessionState = { id: "pinned", cwd: ".", systemPrompt: "", permissionMode: "read-only", model: "model-on-session", messages: [] };
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
    expect(capture()?.system).toBe(buildSystemPrompt(""));
    expect(askedFor).toEqual([sessionCwd]);
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
      // Written the way a pre-`model` seri wrote it: the field is absent, not undefined.
      const legacy = { id: "legacy", cwd: ".", systemPrompt: "", permissionMode: "read-only", messages: [] };
      writeFileSync(join(sessionsDir, "legacy.json"), JSON.stringify(legacy));
      expect("model" in JSON.parse(readFileSync(join(sessionsDir, "legacy.json"), "utf8"))).toBe(false);

      const { code } = await captureLogs(() =>
        run(["--resume", "legacy", "another", "task"], {
          runLoop: fakeRunLoop().fake,
          loadAgentsFile: () => "",
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
      await run(["write", "hello.txt"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir });
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
  test("the approval prompt it gives runLoop resolves false on abort instead of hanging", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

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

    const { fake } = fakeRunLoop([
      { type: "tool-result", name: "edit", result: "edited text" },
      { type: "tool-result", name: "write_file", result: "ok" },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["edit", "a.txt"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
      run(["write", "a.ts"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
            diagnostics: Array.from({ length: 20 }, () => ({ file: "a.ts", line: 1, column: 1, message: "error TS2322: nope" })),
            truncated: false,
            inWrittenFile: 1,
            total: 300,
          } satisfies CheckOutcome,
        },
      },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["write", "a.ts"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
      run(["write", "a.ts"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
          verification: { status: "ok", command: "tsc --noEmit", elapsedMs: 3600 } satisfies CheckOutcome,
        },
      },
      { type: "done", reason: "no-tool-call" },
    ]);

    const { logs } = await captureLogs(() =>
      run(["write", "a.ts"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
      run(["say", "hi"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
  function usageEvent(inputTokens: number | undefined, outputTokens: number | undefined): LoopEvent {
    return {
      type: "usage",
      usage: {
        inputTokens,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokens,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      },
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
      run(["say", "hi"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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

    const { fake } = fakeRunLoop([usageEvent(320, undefined), { type: "done", reason: "no-tool-call" }]);

    const { logs } = await captureLogs(() =>
      run(["say", "hi"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(logs.filter((line) => line.includes("tokens:"))).toEqual(["\n(tokens: 320 in)"]);
  });

  // The other side of that line, and the reason it is keyed on undefined rather than on 0: a call
  // that really did report zero output tokens reported something, and the summary says so.
  test("prints a reported zero, which is a measurement rather than a missing field", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake } = fakeRunLoop([usageEvent(320, 0), { type: "done", reason: "no-tool-call" }]);

    const { logs } = await captureLogs(() =>
      run(["say", "hi"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
      run(["say", "hi"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
      run(["say", "hi"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(1);
    expect(logs.filter((line) => line.includes("tokens:"))).toEqual(["\n(tokens: 120 in, 30 out)"]);
  });

  // captureLogs collects console.log's arguments, and a defect that is precisely a missing line
  // boundary cannot fail such an assertion: capturing per call, or trimming, or splitting on "\n"
  // all re-insert the boundary being asserted about. This reconstructs the byte stream instead —
  // console.log's newline included, and the model's own text, which goes out through
  // process.stdout.write and never reaches console.log at all.
  async function captureStdout(invoke: () => Promise<number>): Promise<{ code: number; stdout: string }> {
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
      run(["say", "hi"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
      run(["say", "hi"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
      run(["say", "hi"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
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
      run(["say", "hi"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(0);
  });

  // `run(["config", …])` had no test at all, on the one path that carries a secret. What a
  // fall-through here costs is not an unhandled subcommand: `config` reaching the task path mints a
  // session and persists `set GROQ_API_KEY gsk_live_…` — the user's key, in full — as the task text
  // in the session JSON. So the empty sessions dir is asserted alongside the exit code, which on
  // its own cannot tell "config list succeeded" from "config was never handled".
  test("a config subcommand returns configCommand's exit code and never reaches the task path", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const calls: { args: string[]; configDir: string }[] = [];
    const { fake, capture } = fakeRunLoop();

    const { code } = await captureLogs(() =>
      run(["config", "set", "GROQ_API_KEY", "gsk_live_secret"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        sessionsDir,
        authConfigDir: tmpConfigRoot,
        configCommand: (args, configDir) => {
          calls.push({ args, configDir });
          // Not 0: the task path exits 0 too, so only a code no other path produces distinguishes
          // "configCommand's answer was returned" from "something else answered".
          return 2;
        },
      }),
    );

    expect(code).toBe(2);
    expect(calls).toEqual([{ args: ["set", "GROQ_API_KEY", "gsk_live_secret"], configDir: tmpConfigRoot }]);
    expect(capture()).toBeUndefined();
    expect(readdirSync(sessionsDir)).toEqual([]);
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

      const { fake, capture } = fakeRunLoop();

      const originalLog = console.log;
      console.log = () => {};
      let code: number;
      try {
        code = await run([word, "is", "wrong", "on", "User"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir });
      } finally {
        console.log = originalLog;
      }

      expect(code).toBe(0);
      expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: `${word} is wrong on User` });
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

    const { fake, capture } = fakeRunLoop();

    const originalLog = console.log;
    console.log = () => {};
    try {
      await run(["/mode", "is", "broken,", "fix", "it"], { sessionsDir, runLoop: fake, loadAgentsFile: () => "" });
    } finally {
      console.log = originalLog;
      // Deleted rather than reassigned when it was unset: `process.env.X = undefined` stores the
      // literal string "undefined" and pollutes every later test in the process.
      if (originalKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalKey;
    }

    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "/mode is broken, fix it" });
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

    const { fake, capture } = fakeRunLoop();

    let code: number;
    try {
      code = await run(["--resume", SESSION_ID, "/undo", "the", "rename", "and", "try", "again"], {
        sessionsDir,
        checkpointsDir,
        runLoop: fake,
        loadAgentsFile: () => "",
      });
    } finally {
      // Deleted rather than reassigned when it was unset: `process.env.X = undefined` stores the
      // literal string "undefined" and pollutes every later test in the process.
      if (originalKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = originalKey;
    }

    expect(code).toBe(0);
    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "/undo the rename and try again" });
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("final\n");
  }, 20_000);
});
