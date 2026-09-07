



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
