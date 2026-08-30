import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessResult } from "../../src/tools/spawnCollect";
import { runHook } from "../../src/hooks/run";
import { HOOK_BLOCK_EXIT_CODE, type HookPayload, type HookSpec } from "../../src/hooks/types";

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
    event: "PreToolUse",
    tool: "probe-tool",
    cwd: "/workdir",
    input: { command: "echo hi" },
    ...overrides,
  };
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
    const outcome = await runHook(makeSpec(), makePayload(), undefined, async () =>
      fakeResult({ exitCode: 0 }),
    );
    expect(outcome).toEqual({ kind: "ok" });
  });

  test("exit HOOK_BLOCK_EXIT_CODE blocks with the script's stderr as the reason", async () => {
    const outcome = await runHook(makeSpec(), makePayload(), undefined, async () =>
      fakeResult({ exitCode: HOOK_BLOCK_EXIT_CODE, stderr: "do not touch main\n" }),
    );
    expect(outcome).toEqual({ kind: "block", reason: "do not touch main" });
  });

  test("exit HOOK_BLOCK_EXIT_CODE with empty stderr blocks with a stand-in reason", async () => {
    const outcome = await runHook(makeSpec({ script: "silent-blocker" }), makePayload(), undefined, async () =>
      fakeResult({ exitCode: HOOK_BLOCK_EXIT_CODE, stderr: "" }),
    );
    expect(outcome.kind).toBe("block");
    expect(outcome.kind === "block" && outcome.reason).toContain("silent-blocker");
    // Never handed the model an empty string to explain to the user.
    expect(outcome.kind === "block" && outcome.reason.length > 0).toBe(true);
  });

  test("any other exit code fails, naming the script and the code", async () => {
    const outcome = await runHook(makeSpec({ script: "flaky" }), makePayload(), undefined, async () =>
      fakeResult({ exitCode: 1, stderr: "boom" }),
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("flaky");
    expect(outcome.kind === "failed" && outcome.message).toContain("1");
    expect(outcome.kind === "failed" && outcome.message).toContain("boom");
  });

  test("a timeout fails, naming the timeout rather than the exit code", async () => {
    const outcome = await runHook(makeSpec({ script: "wedged" }), makePayload(), undefined, async () =>
      fakeResult({ exitCode: 1, timedOut: true }),
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("wedged");
    expect(outcome.kind === "failed" && outcome.message.toLowerCase()).toContain("timed out");
  });

  test("a cancelled run rethrows instead of turning into a failed outcome", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = async () => {
      throw new Error("cancelled");
    };
    await expect(runHook(makeSpec(), makePayload(), controller.signal, spawn)).rejects.toThrow(
      "cancelled",
    );
  });

  test("a rejection with no abort signal fires fails rather than rethrows", async () => {
    const spawn = async () => {
      throw new Error("ENOENT: no such file");
    };
    const outcome = await runHook(makeSpec({ script: "missing" }), makePayload(), undefined, spawn);
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("missing");
  });

  test("truncates an over-long reason instead of handing it to the model whole", async () => {
    const outcome = await runHook(makeSpec(), makePayload(), undefined, async () =>
      fakeResult({ exitCode: HOOK_BLOCK_EXIT_CODE, stderr: "x".repeat(10_000) }),
    );
    expect(outcome.kind).toBe("block");
    // Comfortably under the stream cap spawnCollect itself allows, proving this is a second,
    // tighter budget rather than a pass-through of the tool-output one.
    expect(outcome.kind === "block" && outcome.reason.length).toBeLessThan(1_000);
  });
});

// Real subprocesses, via the actual spawnCollect (no injected spawn), split by which interpreter
// the platform under test actually has. CI runs Linux, macOS, and Windows, and each block only
// proves anything on the platform it can run on.
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

  // This is the test that proves the stdin contract actually works: the script only blocks if it
  // can read the tool name back out of its own stdin, so a pass here means the JSON payload really
  // crossed the pipe rather than the script blocking (or not) for an unrelated reason.
  test("reads the JSON payload from stdin and finds the tool name in it", async () => {
    const dir = makeTempDir();
    const path = writeShScript(
      dir,
      "stdin-check",
      'PAYLOAD=$(cat)\nif echo "$PAYLOAD" | grep -q \'"tool":"probe-tool"\'; then\n' +
        '  echo "saw the tool name on stdin" >&2\n  exit 2\nfi\nexit 0',
    );
    const spec = makeSpec({ script: "stdin-check", path, timeoutMs: 10_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir, tool: "probe-tool" }));

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

  // This is the test that proves the stdin contract actually works: the script only blocks if it
  // can read the tool name back out of its own stdin, so a pass here means the JSON payload really
  // crossed the pipe rather than the script blocking (or not) for an unrelated reason.
  test("reads the JSON payload from stdin and finds the tool name in it", async () => {
    const dir = makeTempDir();
    const path = writePs1Script(
      dir,
      "stdin-check",
      "$payload = [Console]::In.ReadToEnd()\n" +
        'if ($payload -match \'"tool":"probe-tool"\') {\n' +
        '  [Console]::Error.WriteLine("saw the tool name on stdin")\n  exit 2\n}\nexit 0',
    );
    const spec = makeSpec({ script: "stdin-check", path, timeoutMs: 15_000 });

    const outcome = await runHook(spec, makePayload({ cwd: dir, tool: "probe-tool" }));

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
