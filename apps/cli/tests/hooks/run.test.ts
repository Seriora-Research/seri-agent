import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../../src/hooks/run";
import {
  HOOK_BLOCK_EXIT_CODE,
  HOOK_REASON_MAX_CHARS,
  type HookPayload,
  type HookSpec,
} from "../../src/hooks/types";
import { _resetBashResolutionForTests } from "../../src/tools/bash";
import type { ProcessResult } from "../../src/tools/spawnCollect";

function makeSpec(overrides: Partial<HookSpec> = {}): HookSpec {
  return {
    event: "PreToolUse",
    script: "probe",
    path: "/does/not/matter/for/the/injected-spawn/unit-tests",
    matcher: undefined,
    timeoutMs: 5_000,
    source: "project",
    filePath: "/hooks.yaml",
    ...overrides,
  };
}

function makePayload(overrides: Partial<HookPayload> = {}): HookPayload {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "probe-tool",
    cwd: "/workdir",
    tool_input: { command: "echo hi" },
    ...overrides,
  };
}

function liveSpec(overrides: Partial<HookSpec> = {}): HookSpec {
  const dir = makeTempDir();
  const path = join(dir, "hook.sh");
  writeFileSync(path, "exit 0\n");
  return makeSpec({ path, ...overrides });
}

function fakeResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

describe("runHook (injected spawn)", () => {
  test("exit 0 is ok", async () => {
    const outcome = await runHook(liveSpec(), makePayload(), undefined, async () =>
      fakeResult({ exitCode: 0 }),
    );
    expect(outcome).toEqual({ kind: "ok" });
  });

  test("exit HOOK_BLOCK_EXIT_CODE blocks with the script's stderr as the reason", async () => {
    const outcome = await runHook(liveSpec(), makePayload(), undefined, async () =>
      fakeResult({ exitCode: HOOK_BLOCK_EXIT_CODE, stderr: "do not touch main\n" }),
    );
    expect(outcome).toEqual({ kind: "block", reason: "do not touch main" });
  });

  test("exit HOOK_BLOCK_EXIT_CODE with empty stderr blocks with a stand-in reason", async () => {
    const outcome = await runHook(
      liveSpec({ script: "silent-blocker" }),
      makePayload(),
      undefined,
      async () => fakeResult({ exitCode: HOOK_BLOCK_EXIT_CODE, stderr: "" }),
    );
    expect(outcome.kind).toBe("block");
    expect(outcome.kind === "block" && outcome.reason).toContain("silent-blocker");

    expect(outcome.kind === "block" && outcome.reason.length > 0).toBe(true);
  });

  test("any other exit code fails, naming the script and the code", async () => {
    const outcome = await runHook(
      liveSpec({ script: "flaky" }),
      makePayload(),
      undefined,
      async () => fakeResult({ exitCode: 1, stderr: "boom" }),
    );
    expect(outcome).toEqual({ kind: "failed", message: "flaky exited 1: boom" });
  });

  test("a timeout fails, naming the timeout rather than the exit code", async () => {
    const outcome = await runHook(
      liveSpec({ script: "wedged" }),
      makePayload(),
      undefined,
      async () => fakeResult({ exitCode: 1, timedOut: true }),
    );
    expect(outcome).toEqual({ kind: "failed", message: "wedged timed out" });
  });

  test("a cancelled run rethrows instead of turning into a failed outcome", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = async () => {
      throw new Error("cancelled");
    };
    await expect(runHook(liveSpec(), makePayload(), controller.signal, spawn)).rejects.toThrow(
      "cancelled",
    );
  });

  test("a spawn throw is unrunnable", async () => {
    const spawn = async () => {
      throw new Error("ENOENT: no such file");
    };
    const outcome = await runHook(liveSpec({ script: "missing" }), makePayload(), undefined, spawn);
    expect(outcome).toEqual({
      kind: "unrunnable",
      message: "missing could not be run: ENOENT: no such file",
    });
  });

  test("a missing script file is unrunnable before spawn", async () => {
    const outcome = await runHook(
      makeSpec({ script: "ghost", path: join(makeTempDir(), "missing.sh") }),
      makePayload(),
      undefined,
      async () => fakeResult({ exitCode: 0 }),
    );
    expect(outcome).toEqual({
      kind: "unrunnable",
      message: "ghost could not be run: no such file",
    });
  });

  test.skipIf(process.platform === "win32")("a missing interpreter is unrunnable", async () => {
    const dir = makeTempDir();
    const path = join(dir, "hook.sh");
    writeFileSync(path, "exit 0\n");
    const originalPath = process.env.PATH;
    _resetBashResolutionForTests();
    process.env.PATH = dir;
    try {
      const outcome = await runHook(makeSpec({ script: "needs-bash", path }), makePayload());
      expect(outcome).toEqual({
        kind: "unrunnable",
        message: "needs-bash: bash is not available on this system",
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      _resetBashResolutionForTests();
    }
  });

  test("truncates an over-long reason instead of handing it to the model whole", async () => {
    const outcome = await runHook(liveSpec(), makePayload(), undefined, async () =>
      fakeResult({ exitCode: HOOK_BLOCK_EXIT_CODE, stderr: "x".repeat(10_000) }),
    );
    expect(outcome.kind).toBe("block");

    expect(outcome.kind === "block" && outcome.reason.length).toBeLessThanOrEqual(
      HOOK_REASON_MAX_CHARS,
    );
  });

  test("an over-long stderr keeps its tail inside the cap", async () => {
    const tail = "UNIQUE-TAIL-CAUSE";
    const outcome = await runHook(
      liveSpec({ script: "noisy" }),
      makePayload(),
      undefined,
      async () => fakeResult({ exitCode: 1, stderr: `${"h".repeat(10_000)}${tail}` }),
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.message.startsWith("noisy exited 1:")).toBe(true);
    expect(outcome.message.endsWith(tail)).toBe(true);
    const excerpt = outcome.message.slice("noisy exited 1: ".length);
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(HOOK_REASON_MAX_CHARS);
  });
});

const describeSh = process.platform === "win32" ? describe.skip : describe;
const describePs1 = process.platform === "win32" ? describe : describe.skip;

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-hooks-run-"));
  tempDirs.push(dir);
  return dir;
}

function writeShScript(dir: string, name: string, body: string): string {
  const path = join(dir, `${name}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function writePs1Script(dir: string, name: string, body: string): string {
  const path = join(dir, `${name}.ps1`);
  writeFileSync(path, `${body}\n`);
  return path;
}

describeSh("runHook (real bash subprocess)", () => {
  test("a script that exits 0 is ok — negative control for the block assertions below", async () => {
    const dir = makeTempDir();
    const path = writeShScript(dir, "ok", "exit 0");
    const spec = makeSpec({ script: "ok", path, timeoutMs: 10_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir }));

    expect(outcome).toEqual({ kind: "ok" });
  }, 15_000);

  test("a script that exits 2 with a message on stderr produces a block carrying it", async () => {
    const dir = makeTempDir();
    const path = writeShScript(dir, "blocker", 'echo "blocked: dangerous command" >&2\nexit 2');
    const spec = makeSpec({ script: "blocker", path, timeoutMs: 10_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir }));

    expect(outcome.kind).toBe("block");
    expect(outcome.kind === "block" && outcome.reason).toContain("blocked: dangerous command");
  }, 15_000);

  test("reads the JSON payload from stdin and finds the tool name in it", async () => {
    const dir = makeTempDir();
    const path = writeShScript(
      dir,
      "stdin-check",
      'PAYLOAD=$(cat)\nif echo "$PAYLOAD" | grep -q \'"tool_name":"probe-tool"\'; then\n' +
        '  echo "saw the tool name on stdin" >&2\n  exit 2\nfi\nexit 0',
    );
    const spec = makeSpec({ script: "stdin-check", path, timeoutMs: 10_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir, tool_name: "probe-tool" }));

    expect(outcome.kind).toBe("block");
    expect(outcome.kind === "block" && outcome.reason).toContain("saw the tool name on stdin");
  }, 15_000);

  test("a script that never reads stdin and exits 0 is ok and does not crash the process", async () => {
    const dir = makeTempDir();
    const path = writeShScript(dir, "ignores-stdin", "exit 0");
    const spec = makeSpec({ script: "ignores-stdin", path, timeoutMs: 10_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir }));

    expect(outcome).toEqual({ kind: "ok" });
  }, 15_000);

  test("a script that exits 1 fails", async () => {
    const dir = makeTempDir();
    const path = writeShScript(dir, "broken", "exit 1");
    const spec = makeSpec({ script: "broken", path, timeoutMs: 10_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir }));

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("broken");
  }, 15_000);

  test("a missing session directory fails instead of blocking", async () => {
    const hooks = makeTempDir();
    const session = makeTempDir();
    const path = writeShScript(hooks, "deny-all", 'echo "denied by test hook" >&2\nexit 2');
    const spec = makeSpec({ script: "deny-all", path, timeoutMs: 10_000 });
    rmSync(session, { recursive: true, force: true });
    tempDirs = tempDirs.filter((dir) => dir !== session);

    const outcome = await runHook(spec, makePayload({ cwd: session }));

    expect(outcome.kind).toBe("unrunnable");
    expect(outcome.kind === "unrunnable" && outcome.message).toContain("deny-all");
    expect(outcome.kind === "unrunnable" && outcome.message).toMatch(
      /ENOENT|no such file|posix_spawn|spawn/i,
    );
  }, 15_000);
});

describePs1("runHook (real powershell subprocess)", () => {
  test("a script that exits 0 is ok — negative control for the block assertions below", async () => {
    const dir = makeTempDir();
    const path = writePs1Script(dir, "ok", "exit 0");
    const spec = makeSpec({ script: "ok", path, timeoutMs: 15_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir }));

    expect(outcome).toEqual({ kind: "ok" });
  }, 20_000);

  test("a script that exits 2 with a message on stderr produces a block carrying it", async () => {
    const dir = makeTempDir();
    const path = writePs1Script(
      dir,
      "blocker",
      '[Console]::Error.WriteLine("blocked: dangerous command")\nexit 2',
    );
    const spec = makeSpec({ script: "blocker", path, timeoutMs: 15_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir }));

    expect(outcome.kind).toBe("block");
    expect(outcome.kind === "block" && outcome.reason).toContain("blocked: dangerous command");
  }, 20_000);

  test("reads the JSON payload from stdin and finds the tool name in it", async () => {
    const dir = makeTempDir();
    const path = writePs1Script(
      dir,
      "stdin-check",

      "$payload = [Console]::In.ReadToEnd()\n" +
        'if (($payload | ConvertFrom-Json).tool_name -eq "probe-tool") {\n' +
        '  [Console]::Error.WriteLine("saw the tool name on stdin")\n  exit 2\n}\nexit 0',
    );
    const spec = makeSpec({ script: "stdin-check", path, timeoutMs: 15_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir, tool_name: "probe-tool" }));

    expect(outcome.kind).toBe("block");
    expect(outcome.kind === "block" && outcome.reason).toContain("saw the tool name on stdin");
  }, 20_000);

  test("a script that never reads stdin and exits 0 is ok and does not crash the process", async () => {
    const dir = makeTempDir();
    const path = writePs1Script(dir, "ignores-stdin", "exit 0");
    const spec = makeSpec({ script: "ignores-stdin", path, timeoutMs: 15_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir }));

    expect(outcome).toEqual({ kind: "ok" });
  }, 20_000);

  test("a script that exits 1 fails", async () => {
    const dir = makeTempDir();
    const path = writePs1Script(dir, "broken", "exit 1");
    const spec = makeSpec({ script: "broken", path, timeoutMs: 15_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir }));

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("broken");
  }, 20_000);
});
