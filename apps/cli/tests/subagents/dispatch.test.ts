import { describe, expect, test } from "bun:test";
import type { ModelCatalog } from "@seri/model-catalog";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LoopEvent, runLoop } from "../../src/loop/loop";
import { runLoop as realRunLoop } from "../../src/loop/loop";
import { DISPATCH_TOOL_NAME } from "../../src/provider/tools";
import {
  createDispatchTool,
  type ChildEventPayload,
  type DispatchResult,
  runSubagent,
  type SubagentRuntime,
} from "../../src/subagents/dispatch";
import { buildRoleToolSet } from "../../src/subagents/roles";
import { collect, streamResult, textOnlyChunks, toolCallChunks } from "../loop/fixtures";
import { fakeChildLoop } from "./fakeChildLoop";

type RunLoopOpts = Parameters<typeof runLoop>[0];

function dispatchOpts(
  toolCallId: string,
  messages: ModelMessage[] = [],
  abortSignal?: AbortSignal,
) {
  return { toolCallId, messages, context: {}, abortSignal };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeBarrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function usageEvent(inputTokens?: number, outputTokens?: number): LoopEvent {
  const totalTokens =
    inputTokens === undefined && outputTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (outputTokens ?? 0);
  const usage: LanguageModelUsage = {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens,
  };
  return { type: "usage", usage };
}

function makeRuntime(
  fake: (opts: RunLoopOpts) => AsyncGenerator<LoopEvent>,
  overrides: Partial<SubagentRuntime & { system: string }> = {},
): SubagentRuntime & { system: string } {
  const catalog: ModelCatalog = { fetchedAt: "", entries: [] };
  return {
    runLoop: fake as unknown as typeof runLoop,
    model: new MockLanguageModelV4({}),
    provider: "groq",
    modelId: "test-model",
    catalog,
    system: "PARENT SYSTEM",
    permissionMode: () => "auto",
    allowedTools: [],
    reasoningEffort: undefined,
    ...overrides,
  };
}

describe("dispatch_subagents", () => {
  test("parallel explore subagents return summaries (and run concurrently, not sequentially)", async () => {
    const barrier = makeBarrier();
    const { fake, calls } = fakeChildLoop((_opts, index) => {
      if (index === 0) {
        return {
          events: [
            { type: "text-delta", text: "summary A" },
            { type: "done", reason: "no-tool-call" },
          ],
          before: async () => {
            await barrier.promise;
            await sleep(20);
          },
        };
      }
      return {
        events: [
          { type: "text-delta", text: "summary B" },
          { type: "done", reason: "no-tool-call" },
        ],
        before: async () => {
          barrier.resolve();
        },
      };
    });

    const dispatchTool = createDispatchTool(makeRuntime(fake));
    const dispatchPromise = dispatchTool.execute(
      {
        tasks: [
          { role: "explore", goal: "a" },
          { role: "explore", goal: "b" },
        ],
      },
      dispatchOpts("t1"),
    );
    const guard = new Promise<never>((_resolve, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              "dispatch did not run tasks concurrently: the second task never started while the first was in flight",
            ),
          ),
        2000,
      );
    });

    const result = (await Promise.race([dispatchPromise, guard])) as DispatchResult;

    expect(result.results[0].summary).toBe("summary A");
    expect(result.results[1].summary).toBe("summary B");
    expect(calls[1].startedAt).toBeLessThan(calls[0].endedAt as number);
  });

  // Half 2 of the recursion guard (roles.test.ts's "no role's ToolSet contains dispatch_subagents"
  // is half 1): a model that tries to call it anyway, against the REAL runLoop, gets the same
  // "Unknown tool" error any made-up tool name would (loop.ts:499-508) — not a nested dispatch.
  test("a child that calls dispatch_subagents anyway gets Unknown tool, never a nested dispatch", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(
          toolCallChunks("call-1", "dispatch_subagents", {
            tasks: [{ role: "explore", goal: "nested" }],
          }),
        ),
        streamResult(textOnlyChunks("stopped")),
      ],
    });
    const events = await collect(
      realRunLoop({
        model,
        tools: buildRoleToolSet("explore"),
        messages: [{ role: "user", content: "go" }],
        permissionMode: "auto",
      }),
    );

    expect(events).toContainEqual({
      type: "error",
      error: 'Unknown tool "dispatch_subagents": no matching tool definition.',
    });
    expect(events.some((e) => e.type === "tool-call" && e.name === "dispatch_subagents")).toBe(
      false,
    );
  });

  test("token multiplication is measured: totalUsage is the exact arithmetic sum of each child's usage", async () => {
    const { fake } = fakeChildLoop((_opts, index) => {
      if (index === 0)
        return { events: [usageEvent(10, 5), { type: "done", reason: "no-tool-call" }] };
      if (index === 1)
        return { events: [usageEvent(3, 2), { type: "done", reason: "no-tool-call" }] };
      // No usage event at all: this child's fields must stay undefined, not default to 0.
      return { events: [{ type: "done", reason: "no-tool-call" }] };
    });

    const dispatchTool = createDispatchTool(makeRuntime(fake));
    const result = (await dispatchTool.execute(
      {
        tasks: [
          { role: "explore", goal: "a" },
          { role: "explore", goal: "b" },
          { role: "explore", goal: "c" },
        ],
      },
      dispatchOpts("t1"),
    )) as DispatchResult;

    expect(result.results[0].usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(result.results[1].usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(result.results[2].usage).toEqual({});
    expect(result.totalUsage).toEqual({ inputTokens: 13, outputTokens: 7, totalTokens: 20 });
  });

  test("onChildEvent forwards child-started, tool-call, and done for two explore children", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [
        { type: "tool-call", name: "read_file", args: { path: "foo.ts" } },
        { type: "done", reason: "no-tool-call" },
      ],
    }));
    const forwarded: ChildEventPayload[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        onChildEvent: (payload) => forwarded.push(payload),
      }),
    );
    await dispatchTool.execute(
      {
        tasks: [
          { role: "explore", goal: "find a" },
          { role: "explore", goal: "find b" },
        ],
      },
      dispatchOpts("t1"),
    );

    const byId = new Map<string, ChildEventPayload[]>();
    for (const payload of forwarded) {
      const list = byId.get(payload.childId) ?? [];
      list.push(payload);
      byId.set(payload.childId, list);
    }
    expect([...byId.keys()].sort()).toEqual(["t1:0", "t1:1"]);

    const childA = byId.get("t1:0")!;
    const childB = byId.get("t1:1")!;
    expect(childA.map((p) => p.event.type)).toEqual(["child-started", "tool-call", "done"]);
    expect(childB.map((p) => p.event.type)).toEqual(["child-started", "tool-call", "done"]);
    expect(childA[0]).toMatchObject({ role: "explore", goal: "find a" });
    expect(childB[0]).toMatchObject({ role: "explore", goal: "find b" });
    expect(childA[1].event).toEqual({
      type: "tool-call",
      name: "read_file",
      args: { path: "foo.ts" },
    });
    expect(childB[1].event).toEqual({
      type: "tool-call",
      name: "read_file",
      args: { path: "foo.ts" },
    });
  });

  test("runSubagent without child never invokes onChildEvent", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [
        { type: "tool-call", name: "read_file", args: { path: "foo.ts" } },
        { type: "done", reason: "no-tool-call" },
      ],
    }));
    const forwarded: ChildEventPayload[] = [];
    await runSubagent({
      tools: buildRoleToolSet("explore"),
      system: "irrelevant",
      messages: [{ role: "user", content: "go" }],
      runtime: makeRuntime(fake, {
        onChildEvent: (payload) => forwarded.push(payload),
      }),
    });
    expect(forwarded).toEqual([]);
  });

  test("overflow tasks emit no onChildEvent payloads", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [
        { type: "tool-call", name: "read_file", args: { path: "foo.ts" } },
        { type: "done", reason: "no-tool-call" },
      ],
    }));
    const forwarded: ChildEventPayload[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        onChildEvent: (payload) => forwarded.push(payload),
      }),
    );
    const result = (await dispatchTool.execute(
      {
        tasks: Array.from({ length: 4 }, (_, i) => ({
          role: "explore" as const,
          goal: `task ${i}`,
        })),
      },
      dispatchOpts("t1"),
    )) as DispatchResult;

    expect(calls).toHaveLength(3);
    expect(result.results).toHaveLength(4);
    expect(result.results[3].summary).toContain("3-task limit");
    expect(result.results[3].doneReason).toBeUndefined();

    const childIds = [...new Set(forwarded.map((p) => p.childId))].sort();
    expect(childIds).toEqual(["t1:0", "t1:1", "t1:2"]);
    expect(forwarded.some((p) => p.childId === "t1:3")).toBe(false);
    for (const id of childIds) {
      expect(forwarded.filter((p) => p.childId === id).map((p) => p.event.type)).toEqual([
        "child-started",
        "tool-call",
        "done",
      ]);
    }
  });

  test("onChildUsage is forwarded once per child usage event, with its cost", async () => {
    const { fake } = fakeChildLoop((_opts, index) => {
      const events: LoopEvent[] =
        index === 0
          ? [usageEvent(10, 5), { type: "done", reason: "no-tool-call" }]
          : [{ type: "done", reason: "no-tool-call" }];
      return { events };
    });
    const forwarded: { usage: LanguageModelUsage; cost: unknown }[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        onChildUsage: (usage, cost) => forwarded.push({ usage, cost }),
      }),
    );
    await dispatchTool.execute(
      {
        tasks: [
          { role: "explore", goal: "a" },
          { role: "explore", goal: "b" },
        ],
      },
      dispatchOpts("t1"),
    );

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].usage.inputTokens).toBe(10);
    expect(forwarded[0].cost).toBeUndefined();
  });

  test("onChildEvent forwards usage and compacted", async () => {
    const compacted: LoopEvent = {
      type: "compacted",
      summary: { goal: "g", progress: "p", blockers: "b", nextSteps: "n" },
      evictedCount: 1,
      usage: {
        inputTokens: 8,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 2,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 10,
      },
    };
    const { fake } = fakeChildLoop(() => ({
      events: [usageEvent(10, 5), compacted, { type: "done", reason: "no-tool-call" }],
    }));
    const forwarded: ChildEventPayload[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        onChildEvent: (payload) => forwarded.push(payload),
      }),
    );
    await dispatchTool.execute({ tasks: [{ role: "explore", goal: "a" }] }, dispatchOpts("t1"));

    expect(forwarded.map((p) => p.event.type)).toEqual([
      "child-started",
      "usage",
      "compacted",
      "done",
    ]);
  });

  test("onChildUsage is forwarded for a child compacted event, with no cost", async () => {
    const compacted: LoopEvent = {
      type: "compacted",
      summary: { goal: "g", progress: "p", blockers: "b", nextSteps: "n" },
      evictedCount: 1,
      usage: {
        inputTokens: 8,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 2,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 10,
      },
    };
    const { fake } = fakeChildLoop(() => ({
      events: [compacted, { type: "done", reason: "no-tool-call" }],
    }));
    const forwarded: { usage: LanguageModelUsage; cost: unknown }[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        onChildUsage: (usage, cost) => forwarded.push({ usage, cost }),
      }),
    );
    await dispatchTool.execute({ tasks: [{ role: "explore", goal: "a" }] }, dispatchOpts("t1"));

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].usage.inputTokens).toBe(8);
    expect(forwarded[0].usage.outputTokens).toBe(2);
    expect(forwarded[0].cost).toBeUndefined();
  });

  test("every child gets the exact same AbortSignal handed to execute", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const dispatchTool = createDispatchTool(makeRuntime(fake));
    const controller = new AbortController();
    await dispatchTool.execute(
      {
        tasks: [
          { role: "explore", goal: "a" },
          { role: "explore", goal: "b" },
        ],
      },
      dispatchOpts("t1", [], controller.signal),
    );

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.opts.signal).toBe(controller.signal);
  });

  test("an already-aborted signal still resolves with one row per task", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "aborted" }],
    }));
    const controller = new AbortController();
    controller.abort();
    const dispatchTool = createDispatchTool(makeRuntime(fake));
    const result = (await dispatchTool.execute(
      {
        tasks: [
          { role: "explore", goal: "a" },
          { role: "explore", goal: "b" },
        ],
      },
      dispatchOpts("t1", [], controller.signal),
    )) as DispatchResult;

    expect(result.results).toHaveLength(2);
    expect(result.results[0].summary).toBe("cancelled before it produced a summary");
  });

  // Reader/writer serialization replaces the old per-path claim/conflict/retry mechanism: it
  // closed only one of two confirmed gaps (a `test`-only batch, which mutates via bash/powershell
  // rather than write_file, got neither the checkpoint nor any serialization at all) and its own
  // remedy for the case it did catch was discarding a full child run. One filesystem, one writer at
  // a time is safe by construction, for every mutating tool, not just write_file.
  test("writer-role tasks (code + test) never overlap in wall-clock time", async () => {
    const { fake, calls } = fakeChildLoop((_opts, index) => ({
      events: [{ type: "done", reason: "no-tool-call" }],
      // Only the first writer sleeps — long enough that a second writer starting concurrently
      // would necessarily be timestamped before the first one ends.
      before: index === 0 ? () => sleep(30) : undefined,
    }));

    const dispatchTool = createDispatchTool(makeRuntime(fake));
    await dispatchTool.execute(
      {
        tasks: [
          { role: "code", goal: "write" },
          { role: "test", goal: "run checks" },
        ],
      },
      dispatchOpts("t1"),
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].startedAt).toBeGreaterThanOrEqual(calls[0].endedAt as number);
  });

  test("a reader task and a writer task in the same batch run concurrently", async () => {
    const barrier = makeBarrier();
    const { fake, calls } = fakeChildLoop((_opts, index) => {
      if (index === 0) {
        // The reader (explore): waits for the writer to signal it has started, then a bit longer,
        // so a genuinely sequential run (writer never starts until the reader ends) is told apart
        // from real concurrency.
        return {
          events: [{ type: "done", reason: "no-tool-call" }],
          before: async () => {
            await barrier.promise;
            await sleep(20);
          },
        };
      }
      // The writer (code): signals immediately, proving it started while the reader was in flight.
      return {
        events: [{ type: "done", reason: "no-tool-call" }],
        before: async () => {
          barrier.resolve();
        },
      };
    });

    const dispatchTool = createDispatchTool(makeRuntime(fake));
    const dispatchPromise = dispatchTool.execute(
      {
        tasks: [
          { role: "explore", goal: "a" },
          { role: "code", goal: "b" },
        ],
      },
      dispatchOpts("t1"),
    );
    const guard = new Promise<never>((_resolve, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              "reader and writer tasks did not run concurrently: the writer never started while the reader was in flight",
            ),
          ),
        2000,
      );
    });
    await Promise.race([dispatchPromise, guard]);

    expect(calls[1].startedAt).toBeLessThan(calls[0].endedAt as number);
  });

  test("a compacted event contributes its tokens to the child's usage and totalUsage", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [
        {
          type: "compacted",
          summary: { goal: "g", progress: "p", blockers: "b", nextSteps: "n" },
          evictedCount: 2,
          usage: {
            inputTokens: 4,
            inputTokenDetails: {
              noCacheTokens: 4,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokens: 6,
            outputTokenDetails: { textTokens: 6, reasoningTokens: undefined },
            totalTokens: 10,
          },
        },
        { type: "done", reason: "no-tool-call" },
      ],
    }));

    const dispatchTool = createDispatchTool(makeRuntime(fake));
    const result = (await dispatchTool.execute(
      { tasks: [{ role: "explore", goal: "a" }] },
      dispatchOpts("t1"),
    )) as DispatchResult;

    expect(result.results[0].usage).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
    expect(result.totalUsage).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  });

  // Drives the REAL runLoop (not fakeChildLoop): a `code` child with no tools pre-granted, under
  // approve-each, whose only move is to retry a write. Every attempt is denied (deny-blocked --
  // children get no approvalPrompt, loop.ts's decidePermission), never declined, so
  // consecutiveDenials never trips loop.ts's own "repeated-denials" and the child runs to its
  // (short, here) iteration cap instead. deniedCount is what tells the resulting summary apart from
  // the generic "stopped at the iteration cap" message.
  test("a denied child's summary names the mode and the denial count, not the generic cap message", async () => {
    const model = new MockLanguageModelV4({
      doStream: Array.from({ length: 3 }, () =>
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt", content: "x" })),
      ),
    });
    const runtime: SubagentRuntime = {
      runLoop: realRunLoop,
      model,
      provider: "groq",
      modelId: "test-model",
      catalog: { fetchedAt: "", entries: [] },
      permissionMode: () => "approve-each",
      allowedTools: [],
      maxIterations: 3,
      reasoningEffort: undefined,
    };

    const result = await runSubagent({
      tools: buildRoleToolSet("code"),
      system: "irrelevant",
      messages: [{ role: "user", content: "go" }],
      runtime,
    });

    expect(result.doneReason).toBe("max-iterations");
    expect(result.summary).toContain('"approve-each"');
    expect(result.summary).toContain("3 denied");
    expect(result.summary).not.toContain("iteration cap");
  });

  test("batch cap: only the first 3 tasks run, the rest come back as not-run rows", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const dispatchTool = createDispatchTool(makeRuntime(fake));
    const result = (await dispatchTool.execute(
      {
        tasks: Array.from({ length: 5 }, (_, i) => ({
          role: "explore" as const,
          goal: `task ${i}`,
        })),
      },
      dispatchOpts("t1"),
    )) as DispatchResult;

    expect(calls).toHaveLength(3);
    expect(result.results).toHaveLength(5);
    expect(result.results[3].summary).toContain("3-task limit");
    expect(result.results[4].summary).toContain("3-task limit");
    // {} not zeroed: a row that never ran must read as "never reported", not "reported zero" —
    // addTokens' own "sum what showed up" contract (cli.ts) depends on that distinction.
    expect(result.results[3].usage).toEqual({});
    expect(result.results[3].doneReason).toBeUndefined();
  });

  test("each child's opts match the runtime it was built from", async () => {
    const liveMode: "read-only" | "approve-each" | "auto" = "approve-each";
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const catalog: ModelCatalog = { fetchedAt: "", entries: [] };
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        provider: "openrouter",
        modelId: "some/model",
        catalog,
        contextWindowSize: 12345,
        permissionMode: () => liveMode,
        allowedTools: ["write_file"],
        system: "PARENT SYSTEM TIERS",
        reasoningEffort: "medium",
      }),
    );
    await dispatchTool.execute(
      { tasks: [{ role: "test", goal: "run checks" }] },
      dispatchOpts("t1"),
    );

    const opts = calls[0].opts;
    expect(opts.permissionMode).toBe("approve-each");
    expect(opts.allowedTools).toEqual(["write_file"]);
    expect(opts.maxIterations).toBe(25);
    expect(opts.provider).toBe("openrouter");
    expect(opts.modelId).toBe("some/model");
    expect(opts.catalog).toBe(catalog);
    expect(opts.contextWindowSize).toBe(12345);
    expect(opts.system?.startsWith("PARENT SYSTEM TIERS")).toBe(true);
    expect(opts.system).toContain('"test" subagent');
    expect(opts.reasoningEffort).toBe("medium");
  });

  test("a default runtime leaves nested opts.reasoningEffort undefined", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const dispatchTool = createDispatchTool(makeRuntime(fake));
    await dispatchTool.execute(
      { tasks: [{ role: "explore", goal: "look around" }] },
      dispatchOpts("t1"),
    );

    expect(calls[0].opts.reasoningEffort).toBeUndefined();
  });

  test("a code task takes exactly one pre-dispatch checkpoint snapshot; an all-explore batch takes none", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const snapshots: unknown[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, { checkpointer: (context) => snapshots.push(context) }),
    );

    await dispatchTool.execute(
      { tasks: [{ role: "code", goal: "write" }] },
      dispatchOpts("t1", [{ role: "user", content: "hi" }]),
    );
    expect(snapshots).toEqual([
      { tool: DISPATCH_TOOL_NAME, toolCallId: "t1", args: expect.anything(), rewindTo: 0 },
    ]);

    const dispatchTool2 = createDispatchTool(
      makeRuntime(fake, { checkpointer: (context) => snapshots.push(context) }),
    );
    await dispatchTool2.execute(
      { tasks: [{ role: "explore", goal: "read" }] },
      dispatchOpts("t2", [{ role: "user", content: "hi" }]),
    );
    expect(snapshots).toHaveLength(1);
  });

  // The actual regression test for the confirmed gap: `test` holds bash/powershell, both in
  // FS_MUTATING_TOOL_NAMES, so an all-`test` batch (no `code` task at all) mutates the worktree via
  // shell and must still get the pre-dispatch snapshot, not zero /undo coverage.
  test("an all-test batch (no code) still takes exactly one checkpoint snapshot", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const snapshots: unknown[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, { checkpointer: (context) => snapshots.push(context) }),
    );

    await dispatchTool.execute(
      { tasks: [{ role: "test", goal: "run checks" }] },
      dispatchOpts("t1", [{ role: "user", content: "hi" }]),
    );

    expect(snapshots).toHaveLength(1);
  });
});
