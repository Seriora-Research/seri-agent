// createHookRunner: which specs a subject selects, the order they run in, and what a block or a
// failure has become by the time it reaches the loop. Every case drives the injected `run` seam, so
// nothing here spawns an interpreter — run.test.ts already owns the exit-code mapping and the
// platform pairing, and re-testing them through this factory would only pin them twice.
import { describe, expect, test } from "bun:test";
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

// Queued outcomes plus the call log, because half the claims here are about which hooks did NOT run
// — "the first block wins" is only proved by the absence of a second call, never by the returned
// value, which is identical either way.
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

// The factory is nullable by design and every case below hands it a registry that is not empty, so
// the narrowing lives here instead of in each body. The undefined cases assert on createHookRunner
// directly rather than going through this.
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

  // The boundary "no hooks for EITHER event" draws, and the reason it is not "no hooks for this
  // event": one PostToolUse hook is enough to build the runner, whose onBeforeTool then runs
  // nothing rather than the factory declining to exist and taking the post hook down with it.
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
    // The half the returned value cannot show: with both blocks queued, a runner that kept going
    // would return this same block and still have asked the second script for its opinion.
    expect(fake.calls.map((call) => call.spec.script)).toEqual(["guard"]);
  });

  test("a failure from a hook ahead of the blocker travels with the block", async () => {
    const fake = fakeRun([
      { kind: "failed", message: "lint could not be run" },
      { kind: "block", reason: "do not touch main" },
    ]);
    const runner = builtRunner({
      registry: registryOf([makeSpec({ script: "lint" }), makeSpec({ script: "guard" })]),
      cwd: "/worktree",
      run: fake.run,
    });

    expect(await runner.onBeforeTool("bash", { command: "git push" })).toEqual({
      block: "do not touch main",
      errors: ["lint could not be run"],
    });
  });

  test("onBeforeTool reports every failure and blocks nothing when no hook blocked", async () => {
    const fake = fakeRun([
      { kind: "failed", message: "lint could not be run" },
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
      block: undefined,
      errors: ["lint could not be run", "audit timed out"],
    });
    expect(fake.calls).toHaveLength(3);
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
    // A post block stops nothing, so it must not stop the hooks after it either — the short-circuit
    // that is right for PreToolUse would here silently disarm every script behind the first one.
    expect(fake.calls.map((call) => call.spec.script)).toEqual(["too-late", "behind-it"]);
  });

  // The subject, not the ToolSet key the provider emitted: a hook matching on `mcp` would fire for
  // every server and every tool on it, and one matching a real tool name would never fire at all.
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
        // Present here and absent above, not null above: before the call there is no result, and a
        // null would tell a script the tool returned one.
        tool_response: { url: "…/1" },
      },
    ]);
  });
});
