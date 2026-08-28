import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import { run } from "../../src/cli";
import { getBaseConfigDir, getConfigDir, setProfileOverride } from "../../src/config/paths";
import { writeDaemonDescriptor } from "../../src/daemon/descriptor";
import { DATABASE_FILENAME } from "../../src/session/database";
import { listSessionIds } from "../../src/session/session";
import { deliverSignal } from "../../src/signals";
import { fakeRunLoop } from "./fakeRunLoop";

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

describe("run (argv and usage errors)", () => {
  const originalKey = process.env.GROQ_API_KEY;
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
  });

  afterEach(() => {
    restoreEnv("GROQ_API_KEY", originalKey);
    restoreEnv("HOME", originalHome);
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(tmpConfigRoot, { recursive: true, force: true });
  });

  // `--help` matched nothing in cli.ts, so it fell through to the task path and was sent to the
  // model as the user message: a session file on disk and a full turn burned (5 tool calls,
  // observed live) to answer a request for the usage text. The key has to be set, or getGroqModel
  // throws before saveSession and the last two assertions would pass for the wrong reason.
  test.each(["--help", "-h"])(
    "%p prints usage without creating a session or calling the model",
    async (flag) => {
      process.env.GROQ_API_KEY = "fake-test-key";

      const { fake, capture } = fakeRunLoop();

      const { code, logs } = await captureLogs(() =>
        run([flag], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
      );

      expect(code).toBe(0);
      const usage = logs.join("\n");
      expect(usage).toContain("Usage:");
      expect(usage).toContain("seri serve");
      expect(usage).toContain("seri exec");
      expect(usage).not.toContain("seri config");
      expect(usage).not.toContain("seri login");
      expect(usage).not.toContain("seri usage");
      expect(usage).not.toContain("seri permissions");
      expect(capture()).toBeUndefined();
      expect(readdirSync(sessionsDir)).toEqual([]);
    },
  );

  // The defect above, one argument away: gating on argv.length meant `seri -h config` was not "the
  // whole invocation", so it fell through to the task path and wrote a session file and billed a
  // real turn to answer a request for the usage text. Under parseArgs a flag is a flag in any
  // position, so this form prints usage without ever reaching the task path — and so do `seri
  // --help --resume` and `seri --version --quiet`, both usage errors now rather than a route to
  // the task path at all.
  test.each(["--help", "-h"])(
    "%p followed by another argument still prints usage",
    async (flag) => {
      process.env.GROQ_API_KEY = "fake-test-key";

      const { fake, capture } = fakeRunLoop();

      const { code, logs } = await captureLogs(() =>
        run([flag, "config"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
      );

      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("Usage:");
      expect(capture()).toBeUndefined();
      expect(readdirSync(sessionsDir)).toEqual([]);
    },
  );

  // Inverts the pre-parseArgs behaviour: under parseArgs a flag anywhere in argv is a flag, so
  // `seri fix the --help output` now prints usage and never reaches the model — measured on the
  // compiled binary that `claude fix the --help output` behaves the same way. `--` is the
  // documented escape for a task that contains what looks like a flag, exercised in the same test
  // so it never needs a third copy of this fake.
  test.each(["--help", "-h"])(
    "a task containing %p prints usage instead of reaching the model; -- escapes it",
    async (flag) => {
      process.env.GROQ_API_KEY = "fake-test-key";

      const { fake, capture } = fakeRunLoop();

      const { code, logs } = await captureLogs(() =>
        run(["fix", "the", flag, "output"], {
          runLoop: fake,
          loadAgentsFile: () => "",
          sessionsDir,
        }),
      );

      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("Usage:");
      expect(capture()).toBeUndefined();
      expect(readdirSync(sessionsDir)).toEqual([]);

      await captureLogs(() =>
        run(["--", "fix", "the", flag, "output"], {
          runLoop: fake,
          loadAgentsFile: () => "",
          sessionsDir,
        }),
      );

      expect(capture()?.messages.at(-1)).toEqual({
        role: "user",
        content: `fix the ${flag} output`,
      });
    },
  );

  // The same inversion for the third flag: `seri fix the --selftest flag` now runs the
  // build-verification selftest and never reaches the model; `--` escapes it the same way.
  test("a task containing --selftest runs the selftest instead of reaching the model; -- escapes it", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake, capture } = fakeRunLoop();
    const grepFn = async () => ({
      mode: "content" as const,
      matches: [{ file: "probe.txt", line: 1, text: "seri selftest probe" }],
      truncated: false,
    });

    const { logs } = await captureLogs(() =>
      run(["fix", "the", "--selftest", "flag"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        sessionsDir,
        grep: grepFn,
      }),
    );

    expect(capture()).toBeUndefined();
    expect(logs.join("\n")).toContain("selftest ok");

    await captureLogs(() =>
      run(["--", "fix", "the", "--selftest", "flag"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        sessionsDir,
        grep: grepFn,
      }),
    );

    expect(capture()?.messages.at(-1)).toEqual({
      role: "user",
      content: "fix the --selftest flag",
    });
  });

  test("bare seri prints usage instead of exiting silently", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake, capture } = fakeRunLoop();

    const { code, logs } = await captureLogs(() =>
      run([], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
    // Same two guards as the --help case above: with the key set, a fall-through to the task path
    // would call the model and write a session file rather than failing at getGroqModel.
    expect(capture()).toBeUndefined();
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  // The hole PR #27 left open: `--resume` used to take an optional value, so `--help` after it was
  // rejected as a session id (leading dash) and joined into the task instead — the most recent
  // session resumed and a turn was billed to answer a request for the usage text. `--resume` now
  // takes a mandatory value, and parseArgs itself throws on this shape (measured) before any of our
  // code runs, so no case here is written for it beyond routing the throw to exit 2.
  test("`--resume --help` is a usage error, not a resumed session and a billed turn", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake, capture } = fakeRunLoop();

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    let code: number;
    try {
      code = await run(["--resume", "--help"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        sessionsDir,
      });
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(2);
    expect(capture()).toBeUndefined();
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

  test("`--max-turns 3` reaches runLoop as maxIterations", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake, capture } = fakeRunLoop();

    await captureLogs(() =>
      run(["--max-turns", "3", "do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        sessionsDir,
      }),
    );

    expect(capture()?.maxIterations).toBe(3);
  });

  // parseArgs accepts `--max-turns abc` happily (measured) — it has no numeric option type — so
  // this validation is not redundant with the parser's own checks.
  test.each(["0", "abc"])("`--max-turns %s` is a usage error", async (value) => {
    const { fake, capture } = fakeRunLoop();

    const { code } = await captureLogs(() =>
      run(["--max-turns", value, "do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        sessionsDir,
      }),
    );

    expect(code).toBe(2);
    expect(capture()).toBeUndefined();
  });

  test("`--max-turns` with no value is a usage error", async () => {
    const { fake, capture } = fakeRunLoop();

    const { code } = await captureLogs(() =>
      run(["--max-turns"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(2);
    expect(capture()).toBeUndefined();
  });

  test("flags but no task is a usage error", async () => {
    const { fake, capture } = fakeRunLoop();

    const { code } = await captureLogs(() =>
      run(["--max-turns", "5"], { runLoop: fake, loadAgentsFile: () => "", sessionsDir }),
    );

    expect(code).toBe(2);
    expect(capture()).toBeUndefined();
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  test("`--dangerously-skip-permissions` is accepted and reaches runLoop", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";

    const { fake, capture } = fakeRunLoop();

    const { code } = await captureLogs(() =>
      run(["--dangerously-skip-permissions", "do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        sessionsDir,
      }),
    );

    expect(code).not.toBe(2);
    expect(capture()?.permissionMode).toBe("auto");
  });

  // Same shape as "flags but no task is a usage error" above: proves the flag did not accidentally
  // become the task itself.
  test("`--dangerously-skip-permissions` with no task is a usage error, and creates no session", async () => {
    const { fake, capture } = fakeRunLoop();

    const { code } = await captureLogs(() =>
      run(["--dangerously-skip-permissions"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        sessionsDir,
      }),
    );

    expect(code).toBe(2);
    expect(capture()).toBeUndefined();
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  test("`--help` output documents `--dangerously-skip-permissions`", async () => {
    const { logs } = await captureLogs(() => run(["--help"], { sessionsDir }));

    expect(logs.join("\n")).toContain("--dangerously-skip-permissions");
  });

  test("`permissions list` is a task, not an argv verb", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();

    const { code } = await captureLogs(() =>
      run(["permissions", "list"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        sessionsDir,
      }),
    );

    expect(code).toBe(0);
    expect(capture()?.messages.at(-1)).toEqual({
      role: "user",
      content: "permissions list",
    });
  });

  test("`--help` output does not document argv config, login, usage, or permissions", async () => {
    const { logs } = await captureLogs(() => run(["--help"], { sessionsDir }));
    const text = logs.join("\n");
    expect(text).toContain("seri serve");
    expect(text).toContain("seri exec");
    expect(text).not.toContain("seri config");
    expect(text).not.toContain("seri login");
    expect(text).not.toContain("seri usage");
    expect(text).not.toContain("seri permissions");
  });

  test("`usage` is a task, not an argv verb", async () => {
    process.env.GROQ_API_KEY = "fake-test-key";
    const { fake, capture } = fakeRunLoop();
    let called = 0;

    const { code } = await captureLogs(() =>
      run(["usage"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        sessionsDir,
        usageCommand: async () => {
          called += 1;
        },
      }),
    );

    expect(code).toBe(0);
    expect(called).toBe(0);
    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "usage" });
  });

  test("`--detail` is an unknown option", async () => {
    const { fake, capture } = fakeRunLoop();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    let code: number;
    try {
      code = await run(["--detail", "do", "a", "task"], {
        runLoop: fake,
        loadAgentsFile: () => "",
        sessionsDir,
      });
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/detail/i);
    expect(capture()).toBeUndefined();
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  // End-to-end --profile behaviour through run() itself. Deliberately does NOT pass
  // deps.sessionsDir, so the session lands wherever the path layer actually resolves against the
  // beforeEach-redirected HOME above — that is the whole point.
  describe("run (--profile)", () => {
    const originalSeriProfile = process.env.SERI_PROFILE;

    afterEach(() => {
      setProfileOverride(undefined);
      restoreEnv("SERI_PROFILE", originalSeriProfile);
    });

    test("--profile work routes the session under base/work/sessions, not base/sessions", async () => {
      process.env.GROQ_API_KEY = "fake-test-key";
      const { fake, capture } = fakeRunLoop();

      await captureLogs(() =>
        run(["--profile", "work", "do", "a", "task"], { runLoop: fake, loadAgentsFile: () => "" }),
      );

      expect(capture()).toBeDefined();
      const base = getBaseConfigDir();
      expect(listSessionIds(join(base, "work", "sessions"))).toHaveLength(1);
      expect(existsSync(join(base, "work", DATABASE_FILENAME))).toBe(true);
      expect(existsSync(join(base, "sessions"))).toBe(false);
    });

    test("SERI_PROFILE=work with no flag routes the same tree", async () => {
      process.env.GROQ_API_KEY = "fake-test-key";
      process.env.SERI_PROFILE = "work";
      const { fake, capture } = fakeRunLoop();

      await captureLogs(() =>
        run(["do", "a", "task"], { runLoop: fake, loadAgentsFile: () => "" }),
      );

      expect(capture()).toBeDefined();
      const base = getBaseConfigDir();
      expect(listSessionIds(join(base, "work", "sessions"))).toHaveLength(1);
      expect(existsSync(join(base, "sessions"))).toBe(false);
    });

    // The executable form of D1: SERI_PROFILE names one profile, --profile names another, and the
    // flag wins — no envd/ directory is ever created.
    test("--profile beats SERI_PROFILE", async () => {
      process.env.GROQ_API_KEY = "fake-test-key";
      process.env.SERI_PROFILE = "envd";
      const { fake, capture } = fakeRunLoop();

      await captureLogs(() =>
        run(["--profile", "work", "do", "a", "task"], { runLoop: fake, loadAgentsFile: () => "" }),
      );

      expect(capture()).toBeDefined();
      const base = getBaseConfigDir();
      expect(listSessionIds(join(base, "work", "sessions"))).toHaveLength(1);
      expect(existsSync(join(base, "envd"))).toBe(false);
    });

    test("a reserved --profile value is a usage error; the model is never called", async () => {
      const { fake, capture } = fakeRunLoop();

      const { code } = await captureLogs(() =>
        run(["--profile", "sessions", "do", "a", "task"], {
          runLoop: fake,
          loadAgentsFile: () => "",
        }),
      );

      expect(code).toBe(2);
      expect(capture()).toBeUndefined();
      // Rejected before any subcommand dispatch, so nothing under the config root exists at all —
      // not even the base default's own sessions/.
      expect(existsSync(getBaseConfigDir())).toBe(false);
    });

    test("--profile default routes to the base sessions/, no default/ directory", async () => {
      process.env.GROQ_API_KEY = "fake-test-key";
      const { fake, capture } = fakeRunLoop();

      await captureLogs(() =>
        run(["--profile", "default", "do", "a", "task"], {
          runLoop: fake,
          loadAgentsFile: () => "",
        }),
      );

      expect(capture()).toBeDefined();
      const base = getBaseConfigDir();
      expect(listSessionIds(join(base, "sessions"))).toHaveLength(1);
      expect(existsSync(join(base, DATABASE_FILENAME))).toBe(true);
      expect(existsSync(join(base, "default"))).toBe(false);
    });

    test("`--help` output documents `--profile`", async () => {
      const { logs } = await captureLogs(() => run(["--help"]));

      expect(logs.join("\n")).toContain("--profile");
    });

    // A usage error from an UNRELATED flag used to be returned before setProfileOverride ran (it
    // lived in run(), after parseCliArgs), so a previous successful run()'s --profile leaked into
    // this failed call and would have stayed set for whatever run() came after it. Moved into
    // parseCliArgs itself, before any validation that can short-circuit, so every call resets it.
    test("a later run() with an unrelated usage error does not leak a prior --profile override", async () => {
      process.env.GROQ_API_KEY = "fake-test-key";
      const { fake } = fakeRunLoop();

      await captureLogs(() =>
        run(["--profile", "work", "do", "a", "task"], { runLoop: fake, loadAgentsFile: () => "" }),
      );

      const { code } = await captureLogs(() =>
        run(["--max-turns", "garbage", "do", "a", "task"], {
          runLoop: fake,
          loadAgentsFile: () => "",
        }),
      );

      expect(code).toBe(2);
      expect(getConfigDir()).toBe(getBaseConfigDir());
    });
  });
});

describe("run (login/signup/logout)", () => {
  const originalKey = process.env.GROQ_API_KEY;
  const originalHome = process.env.HOME;
  let sessionsDir: string;
  let tmpConfigRoot: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "seri-cli-test-login-sessions-"));
    tmpConfigRoot = mkdtempSync(join(tmpdir(), "seri-cli-test-login-config-"));
    process.env.HOME = tmpConfigRoot;
    process.env.GROQ_API_KEY = "fake-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(tmpConfigRoot, { recursive: true, force: true });
  });

  const failIfCalled = (name: string) => () => {
    throw new Error(`${name} should not be called`);
  };

  test("`seri login` is a task whose user message is login", async () => {
    const { fake, capture } = fakeRunLoop();
    let loginCalled = false;
    const code = await run(["login"], {
      runLoop: fake,
      loadAgentsFile: () => "",
      sessionsDir,
      login: async () => {
        loginCalled = true;
      },
    });

    expect(code).toBe(0);
    expect(loginCalled).toBe(false);
    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "login" });
  });

  test("`seri signup` is a task whose user message is signup", async () => {
    const { fake, capture } = fakeRunLoop();
    let loginCalled = false;
    const code = await run(["signup"], {
      runLoop: fake,
      loadAgentsFile: () => "",
      sessionsDir,
      login: async () => {
        loginCalled = true;
      },
    });

    expect(code).toBe(0);
    expect(loginCalled).toBe(false);
    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "signup" });
  });

  test("`seri logout` is a task whose user message is logout", async () => {
    const { fake, capture } = fakeRunLoop();
    let logoutCalled = false;
    const code = await run(["logout"], {
      runLoop: fake,
      loadAgentsFile: () => "",
      sessionsDir,
      logout: () => {
        logoutCalled = true;
      },
    });

    expect(code).toBe(0);
    expect(logoutCalled).toBe(false);
    expect(capture()?.messages.at(-1)).toEqual({ role: "user", content: "logout" });
  });

  test("`seri --max-turns garbage login` is a usage error", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    let code: number;
    try {
      code = await run(["--max-turns", "garbage", "login"], {
        login: failIfCalled("login"),
        getGroqModel: failIfCalled("getGroqModel"),
        loadAgentsFile: failIfCalled("loadAgentsFile"),
      });
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("--max-turns");
  });

  test.each(["login", "signup", "logout", "usage"])(
    "`seri %s --help` prints seri's usage",
    async (subcommand) => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(String(msg));
      let code: number;
      try {
        code = await run([subcommand, "--help"], {
          login: failIfCalled("login"),
          logout: failIfCalled("logout"),
          getGroqModel: failIfCalled("getGroqModel"),
          loadAgentsFile: failIfCalled("loadAgentsFile"),
        });
      } finally {
        console.log = originalLog;
      }

      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("Usage:");
    },
  );
});

describe("run (serve / exec)", () => {
  const originalHome = process.env.HOME;
  let tmpConfigRoot: string;

  beforeEach(() => {
    tmpConfigRoot = mkdtempSync(join(tmpdir(), "seri-cli-daemon-"));
    process.env.HOME = tmpConfigRoot;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpConfigRoot, { recursive: true, force: true });
  });

  test("`seri serve` starts the daemon and waits until waitForServe resolves", async () => {
    let started = false;
    let stopped = false;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      const code = await run(["serve"], {
        startDaemon: async () => {
          started = true;
          return {
            endpoint: "http://127.0.0.1:9",
            token: "t",
            pid: 1,
            scheduler: { stop() {}, start() {}, tick: async () => {}, create: () => ({}) } as never,
            stop: async () => {
              stopped = true;
            },
          };
        },
        waitForServe: async () => {},
      });
      expect(code).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(started).toBe(true);
    expect(stopped).toBe(true);
    expect(logs.join("\n")).toContain("http://127.0.0.1:9");
  });

  test("`seri exec` without a running daemon exits 1", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    let code: number;
    try {
      code = await run(["exec", "ready"]);
    } finally {
      console.error = originalError;
    }
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("no daemon is running");
  });

  test("`seri exec` without a task is a usage error", async () => {
    const { code } = await (async () => {
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (msg: string) => errors.push(String(msg));
      try {
        return { code: await run(["exec"]), errors };
      } finally {
        console.error = originalError;
      }
    })();
    expect(code).toBe(2);
  });

  test("`seri exec` answers an approval-request with no", async () => {
    writeDaemonDescriptor(getConfigDir(), {
      v: 1,
      endpoint: "http://127.0.0.1:9",
      token: "t",
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    const approvals: unknown[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/v1/turns") {
        const events = [
          {
            v: 1,
            sessionId: "s",
            turnId: "turn-1",
            seq: 1,
            event: {
              type: "approval-request",
              requestId: "r1",
              toolName: "write_file",
              args: { path: "a.txt" },
            },
          },
          {
            v: 1,
            sessionId: "s",
            turnId: "turn-1",
            seq: 2,
            event: { type: "turn-complete", exitCode: 0 },
          },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          status: 200,
        });
      }
      if (url.pathname.includes("/approvals/")) {
        approvals.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      }
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const originalError = console.error;
    const originalLog = console.log;
    console.error = () => {};
    console.log = () => {};
    let code: number;
    try {
      code = await run(["exec", "write"], { fetch: fetchImpl, authConfigDir: getConfigDir() });
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
    expect(code).toBe(0);
    expect(approvals).toEqual([{ answer: "no" }]);
  });

  test("`seri exec` cancels the daemon turn on the first SIGINT", async () => {
    writeDaemonDescriptor(getConfigDir(), {
      v: 1,
      endpoint: "http://127.0.0.1:9",
      token: "t",
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const firstEvent = Promise.withResolvers<void>();
    let cancelled = false;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/v1/turns") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    v: 1,
                    sessionId: "s",
                    turnId: "turn-1",
                    seq: 1,
                    event: { type: "loop", value: { type: "text-delta", text: "x" } },
                  })}\n\n`,
                ),
              );
              firstEvent.resolve();
            },
          }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/cancel")) {
        cancelled = true;
        streamController?.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              v: 1,
              sessionId: "s",
              turnId: "turn-1",
              seq: 2,
              event: { type: "turn-complete", exitCode: 1 },
            })}\n\n`,
          ),
        );
        streamController?.close();
        return Response.json({ ok: true });
      }
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const originalError = console.error;
    const originalLog = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      const running = run(["exec", "go"], { fetch: fetchImpl, authConfigDir: getConfigDir() });
      await firstEvent.promise;
      await Bun.sleep(20);
      deliverSignal("SIGINT");
      expect(await running).toBe(1);
      expect(cancelled).toBe(true);
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
  });

  test("`seri exec` SIGINT cancel network failure does not become an unhandled rejection", async () => {
    writeDaemonDescriptor(getConfigDir(), {
      v: 1,
      endpoint: "http://127.0.0.1:9",
      token: "t",
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const firstEvent = Promise.withResolvers<void>();
    const fetchImpl = (async (input: string | URL | Request) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/v1/turns") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    v: 1,
                    sessionId: "s",
                    turnId: "turn-1",
                    seq: 1,
                    event: { type: "loop", value: { type: "text-delta", text: "x" } },
                  })}\n\n`,
                ),
              );
              firstEvent.resolve();
            },
          }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/cancel")) {
        streamController?.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              v: 1,
              sessionId: "s",
              turnId: "turn-1",
              seq: 2,
              event: { type: "turn-complete", exitCode: 1 },
            })}\n\n`,
          ),
        );
        streamController?.close();
        return new Response("no", { status: 500 });
      }
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const originalError = console.error;
    const originalLog = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      const running = run(["exec", "go"], { fetch: fetchImpl, authConfigDir: getConfigDir() });
      await firstEvent.promise;
      await Bun.sleep(20);
      deliverSignal("SIGINT");
      expect(await running).toBe(1);
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
  });
});
