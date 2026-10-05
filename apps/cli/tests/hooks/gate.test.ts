import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHookRunner, type HookRunner } from "../../src/hooks/gate";
import type {
  HookEvent,
  HookOutcome,
  HookPayload,
  HookRegistry,
  HookSpec,
} from "../../src/hooks/types";

function makeSpec(overrides: Partial<HookSpec> = {}): HookSpec {
  return {
    event: "PreToolUse",
    script: "probe",
    path: "/hooks/probe.sh",
    matcher: undefined,
    timeoutMs: 5_000,
    source: "project",
    filePath: "/hooks.yaml",
    ...overrides,
  };
}

function registryOf(pre: readonly HookSpec[], post: readonly HookSpec[] = []): HookRegistry {
  const registry = new Map<HookEvent, readonly HookSpec[]>();
  if (pre.length > 0) registry.set("PreToolUse", pre);
  if (post.length > 0) registry.set("PostToolUse", post);
  return registry;
}

function fakeRun(outcomes: readonly HookOutcome[]) {
  const calls: { spec: HookSpec; payload: HookPayload }[] = [];
  let next = 0;
  return {
    calls,
    run: async (spec: HookSpec, payload: HookPayload): Promise<HookOutcome> => {
      calls.push({ spec, payload });
      return outcomes[next++] ?? { kind: "ok" };
    },
  };
}

function builtRunner(opts: Parameters<typeof createHookRunner>[0]): HookRunner {
  const runner = createHookRunner(opts);
  if (runner === undefined) throw new Error("expected a runner: this registry is not empty");
  return runner;
}

describe("createHookRunner", () => {
  test("a registry with no hooks at all builds no runner", () => {
    expect(createHookRunner({ registry: new Map(), cwd: "/worktree" })).toBeUndefined();
  });

  test("a registry whose event lists are all empty builds no runner", () => {
    const registry: HookRegistry = new Map([
      ["PreToolUse", []],
      ["PostToolUse", []],
    ]);
    expect(createHookRunner({ registry, cwd: "/worktree" })).toBeUndefined();
  });

  test("a PostToolUse-only registry builds a runner whose onBeforeTool runs nothing", async () => {
    const fake = fakeRun([]);
    const runner = builtRunner({
      registry: registryOf([], [makeSpec({ event: "PostToolUse" })]),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onBeforeTool("bash", { command: "ls" })).toEqual({ errors: [] });
    expect(fake.calls).toHaveLength(0);
  });

  test("only the specs whose matcher accepts the subject run, in registry order", async () => {
    const fake = fakeRun([]);
    const runner = builtRunner({
      registry: registryOf([
        makeSpec({ script: "writes-only", matcher: /^(?:write_file)$/ }),
        makeSpec({ script: "shells-only", matcher: /^(?:bash)$/ }),
        makeSpec({ script: "everything", matcher: undefined }),
      ]),
      cwd: "/worktree",
      run: fake.run,
    });

    await runner.onBeforeTool("bash", { command: "ls" });
    expect(fake.calls.map((call) => call.spec.script)).toEqual(["shells-only", "everything"]);
  });

  test("the first block wins and the hooks behind it never run", async () => {
    const fake = fakeRun([
      { kind: "block", reason: "do not touch main" },
      { kind: "block", reason: "a second opinion nobody needs" },
    ]);
    const runner = builtRunner({
      registry: registryOf([makeSpec({ script: "guard" }), makeSpec({ script: "behind-it" })]),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onBeforeTool("bash", { command: "git push" })).toEqual({
      block: "do not touch main",
      errors: [],
    });

    expect(fake.calls.map((call) => call.spec.script)).toEqual(["guard"]);
  });

  test("a failed PreToolUse hook reports the notice and later matching hooks still run", async () => {
    const fake = fakeRun([{ kind: "failed", message: "lint exited 1: boom" }, { kind: "ok" }]);
    const runner = builtRunner({
      registry: registryOf([makeSpec({ script: "lint" }), makeSpec({ script: "guard" })]),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onBeforeTool("bash", { command: "git push" })).toEqual({
      errors: ["lint exited 1: boom"],
    });
    expect(fake.calls.map((call) => call.spec.script)).toEqual(["lint", "guard"]);
  });

  test("an unrunnable PreToolUse hook denies and the hooks behind it never run", async () => {
    const message = "deny-all could not be run: ENOENT";
    const fake = fakeRun([
      { kind: "unrunnable", message },
      { kind: "block", reason: "do not touch main" },
    ]);
    const runner = builtRunner({
      registry: registryOf([makeSpec({ script: "deny-all" }), makeSpec({ script: "guard" })]),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onBeforeTool("bash", { command: "git push" })).toEqual({
      block: message,
      errors: [message],
    });
    expect(fake.calls.map((call) => call.spec.script)).toEqual(["deny-all"]);
  });

  test("onBeforeTool collects every failed notice instead of stopping at the first", async () => {
    const fake = fakeRun([
      { kind: "failed", message: "lint exited 1: boom" },
      { kind: "ok" },
      { kind: "failed", message: "audit timed out" },
    ]);
    const runner = builtRunner({
      registry: registryOf([
        makeSpec({ script: "lint" }),
        makeSpec({ script: "fine" }),
        makeSpec({ script: "audit" }),
      ]),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onBeforeTool("bash", { command: "ls" })).toEqual({
      errors: ["lint exited 1: boom", "audit timed out"],
    });
    expect(fake.calls.map((call) => call.spec.script)).toEqual(["lint", "fine", "audit"]);
  });

  test("a second identical failure is omitted and a distinct one is not", async () => {
    const repeated = "lint exited 1: boom";
    const fake = fakeRun([
      { kind: "failed", message: repeated },
      { kind: "failed", message: repeated },
      { kind: "failed", message: "audit timed out" },
    ]);
    const runner = builtRunner({
      registry: registryOf([makeSpec({ script: "lint" })]),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onBeforeTool("bash", { command: "ls" })).toEqual({ errors: [repeated] });
    expect(await runner.onBeforeTool("bash", { command: "ls" })).toEqual({ errors: [] });
    expect(await runner.onBeforeTool("bash", { command: "ls" })).toEqual({
      errors: ["audit timed out"],
    });
  });

  test("an ok PreToolUse hook still admits", async () => {
    const fake = fakeRun([{ kind: "ok" }]);
    const runner = builtRunner({
      registry: registryOf([makeSpec({ script: "fine" })]),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onBeforeTool("bash", { command: "ls" })).toEqual({ errors: [] });
  });

  test("onAfterTool runs every matching hook and returns each failure message", async () => {
    const fake = fakeRun([{ kind: "failed", message: "format failed" }, { kind: "ok" }]);
    const runner = builtRunner({
      registry: registryOf(
        [],
        [
          makeSpec({ event: "PostToolUse", script: "format" }),
          makeSpec({ event: "PostToolUse", script: "log" }),
        ],
      ),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onAfterTool("write_file", { path: "a.txt" }, "wrote 3 lines")).toEqual([
      "format failed",
    ]);
    expect(fake.calls).toHaveLength(2);
  });

  test("onAfterTool omits a failure message it already returned", async () => {
    const message = "format exited 1: boom";
    const fake = fakeRun([
      { kind: "failed", message },
      { kind: "failed", message },
    ]);
    const runner = builtRunner({
      registry: registryOf([], [makeSpec({ event: "PostToolUse", script: "format" })]),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onAfterTool("write_file", { path: "a.txt" }, "wrote 3 lines")).toEqual([
      message,
    ]);
    expect(await runner.onAfterTool("write_file", { path: "a.txt" }, "wrote 3 lines")).toEqual([]);
  });

  test("an identical failure is delivered once across PreToolUse and PostToolUse", async () => {
    const message = "lint exited 1: boom";
    const fake = fakeRun([
      { kind: "failed", message },
      { kind: "failed", message },
    ]);
    const runner = builtRunner({
      registry: registryOf(
        [makeSpec({ script: "lint" })],
        [makeSpec({ event: "PostToolUse", script: "lint" })],
      ),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onBeforeTool("write_file", { path: "a.txt" })).toEqual({
      errors: [message],
    });
    expect(await runner.onAfterTool("write_file", { path: "a.txt" }, "wrote 3 lines")).toEqual([]);
  });

  test("onAfterTool reports a block as a message, because exit 2 cannot un-run the tool", async () => {
    const fake = fakeRun([{ kind: "block", reason: "that file is generated" }, { kind: "ok" }]);
    const runner = builtRunner({
      registry: registryOf(
        [],
        [
          makeSpec({ event: "PostToolUse", script: "too-late" }),
          makeSpec({ event: "PostToolUse", script: "behind-it" }),
        ],
      ),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onAfterTool("write_file", { path: "a.txt" }, "wrote 3 lines")).toEqual([
      "that file is generated",
    ]);

    expect(fake.calls.map((call) => call.spec.script)).toEqual(["too-late", "behind-it"]);
  });

  test("the payload carries the event, the subject, the cwd and the tool's own input", async () => {
    const fake = fakeRun([]);
    const runner = builtRunner({
      registry: registryOf([makeSpec()], [makeSpec({ event: "PostToolUse" })]),
      cwd: "/worktree",
      run: fake.run,
    });

    await runner.onBeforeTool("mcp__github__create_issue", { title: "a bug" });
    await runner.onAfterTool("mcp__github__create_issue", { title: "a bug" }, { url: "…/1" });

    expect(fake.calls.map((call) => call.payload)).toEqual([
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__github__create_issue",
        cwd: "/worktree",
        tool_input: { title: "a bug" },
      },
      {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__github__create_issue",
        cwd: "/worktree",
        tool_input: { title: "a bug" },

        tool_response: { url: "…/1" },
      },
    ]);
  });
});

const describeSh = process.platform === "win32" ? describe.skip : describe;

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-hooks-gate-"));
  tempDirs.push(dir);
  return dir;
}

function writeDenyAll(dir: string): string {
  const path = join(dir, "deny-all.sh");
  writeFileSync(path, '#!/usr/bin/env bash\necho "denied by test hook" >&2\nexit 2\n');
  chmodSync(path, 0o755);
  return path;
}

function expectFailClosed(
  result: { readonly block?: string; readonly errors?: readonly string[] },
  script: string,
  detail: RegExp,
): void {
  const block = result.block;
  if (block === undefined) throw new Error(`expected ${script} to deny the call`);
  expect(block).toContain(script);
  expect(block).toMatch(detail);
  expect(result.errors).toEqual([block]);
}

describeSh("createHookRunner (real bash subprocess)", () => {
  test("a deny-all hook still blocks while the session directory exists", async () => {
    const session = makeTempDir();
    const hooks = makeTempDir();
    const path = writeDenyAll(hooks);
    const runner = builtRunner({
      registry: registryOf([makeSpec({ script: "deny-all", path, timeoutMs: 10_000 })]),
      cwd: session,
    });

    const result = await runner.onBeforeTool("write_file", { path: "/tmp/bypass.txt" });
    expect(result.block).toBe("denied by test hook");
  }, 15_000);

  test("a missing session directory denies instead of skipping the hook", async () => {
    const session = makeTempDir();
    const hooks = makeTempDir();
    const path = writeDenyAll(hooks);
    rmSync(session, { recursive: true, force: true });
    tempDirs = tempDirs.filter((dir) => dir !== session);

    const runner = builtRunner({
      registry: registryOf([makeSpec({ script: "deny-all", path, timeoutMs: 10_000 })]),
      cwd: session,
    });

    const result = await runner.onBeforeTool("write_file", { path: "/tmp/bypass.txt" });
    expectFailClosed(result, "deny-all", /ENOENT|no such file|posix_spawn|spawn/i);
  }, 15_000);

  test("a missing hook script denies instead of allowing", async () => {
    const session = makeTempDir();
    const runner = builtRunner({
      registry: registryOf([
        makeSpec({
          script: "ghost",
          path: join(session, "does-not-exist.sh"),
          timeoutMs: 10_000,
        }),
      ]),
      cwd: session,
    });

    const result = await runner.onBeforeTool("write_file", { path: "/tmp/bypass.txt" });
    expectFailClosed(result, "ghost", /exited 127|no such file|enoent|could not be run/i);
  }, 15_000);
});
