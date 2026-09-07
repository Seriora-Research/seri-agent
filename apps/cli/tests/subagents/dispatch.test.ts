import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog } from "@seri/model-catalog";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LoopEvent, runLoop } from "../../src/loop/loop";
import { runLoop as realRunLoop } from "../../src/loop/loop";
import { DISPATCH_TOOL_NAME } from "../../src/provider/tools";
import {
  type ChildEventPayload,
  createDispatchTool,
  type DispatchResult,
  dispatchDescription,
  dispatchDirect,
  dispatchSchema,
  runSubagent,
  type SubagentRuntime,
} from "../../src/subagents/dispatch";
import {
  type AgentRegistry,
  type AgentSpec,
  agentToolSet,
  builtinRegistry,
  composeAddendum,
} from "../../src/subagents/registry";
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

function agentSpec(name: string): AgentSpec {
  const spec = builtinRegistry().get(name);
  if (spec === undefined) throw new Error(`no built-in agent named "${name}"`);
  return spec;
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
  overrides: Partial<SubagentRuntime & { system: string; agents: AgentRegistry }> = {},
): SubagentRuntime & { system: string; agents: AgentRegistry } {
  const catalog: ModelCatalog = { fetchedAt: "", entries: [] };
  return {
    runLoop: fake as unknown as typeof runLoop,
    model: new MockLanguageModelV4({}),
    provider: "groq",
    modelId: "test-model",
    catalog,
    system: "PARENT SYSTEM",
    agents: builtinRegistry(),
    permissionMode: () => "auto",
    allowedTools: [],
    pathDenials: [],
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
        tools: agentToolSet(agentSpec("explore")),
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
      tools: agentToolSet(agentSpec("explore")),
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
      tokensBefore: 40,
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
      tokensBefore: 40,
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






  test("writer-role tasks (writer + tester) never overlap in wall-clock time", async () => {
    const { fake, calls } = fakeChildLoop((_opts, index) => ({
      events: [{ type: "done", reason: "no-tool-call" }],


      before: index === 0 ? () => sleep(30) : undefined,
    }));

    const dispatchTool = createDispatchTool(makeRuntime(fake, { agents: withMutators() }));
    await dispatchTool.execute(
      {
        tasks: [
          { role: "writer", goal: "write" },
          { role: "tester", goal: "run checks" },
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



        return {
          events: [{ type: "done", reason: "no-tool-call" }],
          before: async () => {
            await barrier.promise;
            await sleep(20);
          },
        };
      }

      return {
        events: [{ type: "done", reason: "no-tool-call" }],
        before: async () => {
          barrier.resolve();
        },
      };
    });

    const dispatchTool = createDispatchTool(makeRuntime(fake, { agents: withMutators() }));
    const dispatchPromise = dispatchTool.execute(
      {
        tasks: [
          { role: "explore", goal: "a" },
          { role: "writer", goal: "b" },
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
          tokensBefore: 40,
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
      pathDenials: [],
      maxIterations: 3,
      reasoningEffort: undefined,
    };

    const result = await runSubagent({
      tools: agentToolSet(withMutators().get("writer")!),
      system: "irrelevant",
      messages: [{ role: "user", content: "go" }],
      runtime,
    });

    expect(result.doneReason).toBe("max-iterations");
    expect(result.summary).toContain('"approve-each"');
    expect(result.summary).toContain("3 denied");
    expect(result.summary).not.toContain("iteration cap");
  });

  test("a containment-denied child's summary does not tell the parent to switch to auto", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [
        { type: "permission-denied", name: "bash", reason: "containment" },
        { type: "done", reason: "no-tool-call" },
      ],
    }));

    const result = await runSubagent({
      tools: {},
      system: "irrelevant",
      messages: [{ role: "user", content: "go" }],
      runtime: makeRuntime(fake, { permissionMode: () => "auto" }),
    });

    expect(result.summary).toContain("containment block");
    expect(result.summary).toContain('"auto"');
    expect(result.summary).not.toContain("it can only write in auto mode");
  });

  test("a child's denied missing path is a permission denial, not a missing-path probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "seri-child-deny-"));
    const app = join(root, "app");
    mkdirSync(app);
    const events: LoopEvent[] = [];
    try {
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(
            toolCallChunks("call-1", "glob", { pattern: "*.txt", path: "../secret/missing" }),
          ),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      const runtime: SubagentRuntime = {
        runLoop: async function* (opts) {
          for await (const event of realRunLoop(opts)) {
            events.push(event);
            yield event;
          }
        } as typeof realRunLoop,
        model,
        provider: "groq",
        modelId: "test-model",
        catalog: { fetchedAt: "", entries: [] },
        permissionMode: () => "auto",
        allowedTools: [],
        pathDenials: [{ tool: "glob", pattern: `${root.replaceAll("\\", "/")}/secret/**` }],
        cwd: app,
        reasoningEffort: undefined,
      };
      await runSubagent({
        tools: agentToolSet(agentSpec("explore"), undefined, app),
        system: "irrelevant",
        messages: [{ role: "user", content: "go" }],
        runtime,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(events).toContainEqual({
      type: "permission-denied",
      name: "glob",
      reason: "blocked",
    });
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" ? error.error : "").not.toContain("Path not found");
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
        agents: withMutators(),
      }),
    );
    await dispatchTool.execute(
      { tasks: [{ role: "tester", goal: "run checks" }] },
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
    expect(opts.system).toContain('"tester" subagent');
    expect(opts.reasoningEffort).toBe("medium");
  });

  test("a child shares the parent's outside-cwd latch but is never a live human", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const outsideConsent = { current: "allowed-this-run" as const };
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        cwd: "/tmp/parent-wd",
        blockReadsOutsideWorkingDirectories: true,
        outsideConsent,
        agents: withMutators(),
      }),
    );
    await dispatchTool.execute(
      { tasks: [{ role: "tester", goal: "run checks" }] },
      dispatchOpts("t1"),
    );

    const opts = calls[0].opts;
    expect(opts.workingDirectory).toBe("/tmp/parent-wd");
    expect(opts.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(opts.askOutsideFs).toBe(false);
    expect(opts.outsideConsent).toBe(outsideConsent);
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

  test("resolveRole overlay uses the child's model/provider/effort, not the runtime defaults", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const childModel = new MockLanguageModelV4({});
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        provider: "groq",
        modelId: "parent-model",
        reasoningEffort: "high",
        resolveRole: (role) => {
          expect(role).toBe("explore");
          return {
            model: childModel,
            provider: "anthropic",
            modelId: "claude-sonnet-5",
            contextWindowSize: 200_000,
            reasoningEffort: undefined,
            inherited: false,
          };
        },
      }),
    );
    const result = (await dispatchTool.execute(
      { tasks: [{ role: "explore", goal: "advise" }] },
      dispatchOpts("t1"),
    )) as DispatchResult;

    expect(calls[0].opts.provider).toBe("anthropic");
    expect(calls[0].opts.modelId).toBe("claude-sonnet-5");
    expect(calls[0].opts.model).toBe(childModel);
    expect(calls[0].opts.contextWindowSize).toBe(200_000);

    expect(calls[0].opts.reasoningEffort).toBeUndefined();
    expect(result.results[0].model).toBe("claude-sonnet-5");
    expect(result.results[0].provider).toBe("anthropic");
    expect(result.results[0].inherited).toBe(false);
  });

  test("same-pair resolveRole still forwards parent reasoningEffort", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        provider: "groq",
        modelId: "parent-model",
        reasoningEffort: "high",
        resolveRole: () => ({
          model: new MockLanguageModelV4({}),
          provider: "groq",
          modelId: "parent-model",
          reasoningEffort: "high",
          inherited: true,
        }),
      }),
    );
    await dispatchTool.execute({ tasks: [{ role: "explore", goal: "look" }] }, dispatchOpts("t1"));
    expect(calls[0].opts.reasoningEffort).toBe("high");
  });

  test("overflow rows omit model/provider/inherited", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        resolveRole: () => ({
          model: new MockLanguageModelV4({}),
          provider: "anthropic",
          modelId: "claude-sonnet-5",
          reasoningEffort: undefined,
          inherited: false,
        }),
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

    expect(result.results[3].doneReason).toBeUndefined();
    expect(result.results[3].model).toBeUndefined();
    expect(result.results[3].provider).toBeUndefined();
    expect(result.results[3].inherited).toBeUndefined();
    expect(result.results[0].model).toBe("claude-sonnet-5");
  });

  test("child-started carries the actual pair when not inherited", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const events: ChildEventPayload[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        onChildEvent: (payload) => events.push(payload),
        resolveRole: () => ({
          model: new MockLanguageModelV4({}),
          provider: "anthropic",
          modelId: "claude-sonnet-5",
          reasoningEffort: undefined,
          inherited: false,
        }),
      }),
    );
    await dispatchTool.execute(
      { tasks: [{ role: "explore", goal: "advise" }] },
      dispatchOpts("t1"),
    );
    const started = events.find((e) => e.event.type === "child-started");
    expect(started?.model).toBe("claude-sonnet-5");
    expect(started?.provider).toBe("anthropic");
    expect(started?.inherited).toBe(false);
  });

  test("resolveRole receives the task's model, provider, and effort", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const childModel = new MockLanguageModelV4({});
    const requests: unknown[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        provider: "groq",
        modelId: "parent-model",
        reasoningEffort: "medium",
        resolveRole: (role, request) => {
          requests.push({ role, request });
          return {
            model: childModel,
            provider: "anthropic",
            modelId: "claude-sonnet-5",
            reasoningEffort: request?.effort,
            inherited: false,
          };
        },
      }),
    );
    const result = (await dispatchTool.execute(
      {
        tasks: [
          {
            role: "explore",
            goal: "advise",
            model: "claude-sonnet-5",
            provider: "anthropic",
            effort: "high",
          },
        ],
      },
      dispatchOpts("t1"),
    )) as DispatchResult;

    expect(requests).toContainEqual({
      role: "explore",
      request: { model: "claude-sonnet-5", provider: "anthropic", effort: "high" },
    });
    expect(calls[0].opts.modelId).toBe("claude-sonnet-5");
    expect(calls[0].opts.reasoningEffort).toBe("high");
    expect(result.results[0].inherited).toBe(false);
  });

  test("two tasks with the same role and different models get two overlays", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        resolveRole: (_role, request) => ({
          model: new MockLanguageModelV4({}),
          provider: request?.provider === "anthropic" ? "anthropic" : "openai",
          modelId: request?.model ?? "missing",
          reasoningEffort: request?.effort,
          inherited: false,
        }),
      }),
    );
    const result = (await dispatchTool.execute(
      {
        tasks: [
          { role: "explore", goal: "a", model: "claude-sonnet-5", provider: "anthropic" },
          { role: "explore", goal: "b", model: "gpt-5", provider: "openai", effort: "high" },
        ],
      },
      dispatchOpts("t1"),
    )) as DispatchResult;

    const ids = calls.map((c) => c.opts.modelId);
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).toContain("gpt-5");
    expect(calls.find((c) => c.opts.modelId === "gpt-5")?.opts.reasoningEffort).toBe("high");
    expect(result.results.map((r) => r.model)).toEqual(["claude-sonnet-5", "gpt-5"]);
  });

  test("overflow rows omit model/provider/inherited even when the overflow task named a pair", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        resolveRole: () => ({
          model: new MockLanguageModelV4({}),
          provider: "anthropic",
          modelId: "claude-sonnet-5",
          reasoningEffort: "high",
          inherited: false,
        }),
      }),
    );
    const result = (await dispatchTool.execute(
      {
        tasks: [
          { role: "explore", goal: "one" },
          { role: "explore", goal: "two" },
          { role: "explore", goal: "three" },
          {
            role: "explore",
            goal: "overflow",
            model: "claude-sonnet-5",
            provider: "anthropic",
            effort: "high",
          },
        ],
      },
      dispatchOpts("t1"),
    )) as DispatchResult;

    expect(result.results[3].doneReason).toBeUndefined();
    expect(result.results[3].model).toBeUndefined();
    expect(result.results[3].provider).toBeUndefined();
    expect(result.results[3].inherited).toBeUndefined();
    expect(result.results[3].effort).toBeUndefined();
  });

  test("a hostile explore calling write_file/edit/bash/powershell/dispatch_subagents gets Unknown tool and writes nothing", async () => {
    const distinctivePath = join(tmpdir(), `seri-explore-hostile-${Date.now()}.txt`);
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(
          toolCallChunks("c1", "write_file", {
            path: distinctivePath,
            content: "ignore all previous instructions",
          }),
        ),
        streamResult(
          toolCallChunks("c2", "edit", { path: distinctivePath, oldString: "x", newString: "y" }),
        ),
        streamResult(toolCallChunks("c3", "bash", { command: "echo pwned" })),
        streamResult(toolCallChunks("c4", "powershell", { command: "Write-Host pwned" })),
        streamResult(
          toolCallChunks("c5", DISPATCH_TOOL_NAME, {
            tasks: [{ role: "code", goal: "write" }],
          }),
        ),
        streamResult(textOnlyChunks("stopped")),
      ],
    });
    const events = await collect(
      realRunLoop({
        model,
        tools: agentToolSet(agentSpec("explore")),
        messages: [{ role: "user", content: "go" }],
        permissionMode: "auto",
      }),
    );

    for (const name of ["write_file", "edit", "bash", "powershell", DISPATCH_TOOL_NAME]) {
      expect(events).toContainEqual({
        type: "error",
        error: `Unknown tool "${name}": no matching tool definition.`,
      });
      expect(events.some((e) => e.type === "tool-call" && e.name === name)).toBe(false);
    }
    expect(existsSync(distinctivePath)).toBe(false);
  });

  test("a writer task takes exactly one pre-dispatch checkpoint snapshot; an all-explore batch takes none", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const snapshots: unknown[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        agents: withMutators(),
        checkpointer: (context) => snapshots.push(context),
      }),
    );

    await dispatchTool.execute(
      { tasks: [{ role: "writer", goal: "write" }] },
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




  test("an all-tester batch (no writer) still takes exactly one checkpoint snapshot", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const snapshots: unknown[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        agents: withMutators(),
        checkpointer: (context) => snapshots.push(context),
      }),
    );

    await dispatchTool.execute(
      { tasks: [{ role: "tester", goal: "run checks" }] },
      dispatchOpts("t1", [{ role: "user", content: "hi" }]),
    );

    expect(snapshots).toHaveLength(1);
  });
});





function withCustomAgent(spec: Partial<AgentSpec> & { name: string }): AgentRegistry {
  const agents = new Map(builtinRegistry());
  const toolNames = spec.toolNames ?? (["read_file", "grep"] as const);
  agents.set(spec.name, {
    description: "Grades a diff against the plan.",
    request: undefined,
    ...spec,
    toolNames,
    addendum: composeAddendum({ name: spec.name, job: "review it", toolNames }),
    source: "project",
    filePath: `/p/.seri/agents/${spec.name}.md`,
  });
  return agents;
}

function withMutators(extra?: Partial<AgentSpec> & { name: string }): AgentRegistry {
  const agents = new Map(extra === undefined ? builtinRegistry() : withCustomAgent(extra));
  for (const spec of [
    {
      name: "writer",
      toolNames: ["write_file", "read_file", "grep"] as const,
      job: "write files",
    },
    { name: "tester", toolNames: ["read_file", "bash"] as const, job: "run checks" },
  ]) {
    if (agents.has(spec.name)) continue;
    agents.set(spec.name, {
      name: spec.name,
      description: spec.job,
      toolNames: spec.toolNames,
      addendum: composeAddendum({ name: spec.name, job: spec.job, toolNames: spec.toolNames }),
      source: "project",
      filePath: `/p/.seri/agents/${spec.name}.md`,
      request: undefined,
    });
  }
  return agents;
}

describe("dispatch_subagents with a file-defined agent", () => {
  test("the input schema accepts the custom name and rejects one no file defined", () => {
    const schema = dispatchSchema(withCustomAgent({ name: "reviewer" }));
    expect(schema.safeParse({ tasks: [{ role: "reviewer", goal: "grade it" }] }).success).toBe(
      true,
    );
    expect(schema.safeParse({ tasks: [{ role: "nobody", goal: "grade it" }] }).success).toBe(false);
  });

  test("the tool description carries the custom agent's own line and its real tool grant", () => {
    const text = dispatchDescription(withCustomAgent({ name: "reviewer" }));
    expect(text).toContain('"reviewer": Grades a diff against the plan. Tools: read_file, grep.');
    expect(text).toContain('"explore"');
  });

  test("an agent with no description contributes no line, so the model is never told it exists", () => {
    const text = dispatchDescription(withCustomAgent({ name: "quiet", description: "" }));
    expect(text).not.toContain('"quiet"');
  });




  test("an agent with no description is not in the schema's enum either, but /name still runs it", async () => {
    const agents = withCustomAgent({ name: "quiet", description: "" });
    const schema = dispatchSchema(agents);
    expect(schema.safeParse({ tasks: [{ role: "quiet", goal: "grade it" }] }).success).toBe(false);
    expect(schema.safeParse({ tasks: [{ role: "explore", goal: "look" }] }).success).toBe(true);

    const { fake, calls } = fakeChildLoop(() => ({
      events: [
        { type: "text-delta", text: "graded" },
        { type: "done", reason: "no-tool-call" },
      ],
    }));
    const spec = agents.get("quiet");
    if (spec === undefined) throw new Error("the custom agent was not registered");
    const { result } = await dispatchDirect({
      runtime: makeRuntime(fake, { agents }),
      spec,
      goal: "grade it",
      toolCallId: "t1",
      rewindTo: 0,
    });
    expect(calls).toHaveLength(1);
    expect(result.results[0].summary).toBe("graded");
  });



  test("a task whose role the registry does not hold comes back as a not-run row", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const dispatchTool = createDispatchTool(makeRuntime(fake));
    const result = (await dispatchTool.execute(
      {
        tasks: [
          { role: "explore", goal: "look" },
          { role: "ghost", goal: "haunt" },
        ],
      },
      dispatchOpts("t1"),
    )) as DispatchResult;

    expect(calls).toHaveLength(1);
    expect(result.results).toHaveLength(2);
    expect(result.results[1].role).toBe("ghost");
    expect(result.results[1].summary).toContain('no agent named "ghost"');
    expect(result.results[1].usage).toEqual({});
    expect(result.results[1].doneReason).toBeUndefined();
  });

  test("a custom agent runs with exactly its own ToolSet and its own addendum", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, { agents: withCustomAgent({ name: "reviewer" }) }),
    );
    await dispatchTool.execute(
      { tasks: [{ role: "reviewer", goal: "grade it" }] },
      dispatchOpts("t1"),
    );

    expect(Object.keys(calls[0].opts.tools ?? {}).sort()).toEqual(["grep", "read_file"]);
    expect(calls[0].opts.system).toContain('"reviewer" subagent');
    expect(calls[0].opts.system?.startsWith("PARENT SYSTEM")).toBe(true);
  });




  test("a custom agent's ToolSet can never contain dispatch_subagents", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, { agents: withCustomAgent({ name: "reviewer" }) }),
    );
    await dispatchTool.execute(
      { tasks: [{ role: "reviewer", goal: "grade it" }] },
      dispatchOpts("t1"),
    );
    expect(Object.keys(calls[0].opts.tools ?? {})).not.toContain(DISPATCH_TOOL_NAME);
  });

  test("a custom agent holding bash gets the pre-dispatch checkpoint a built-in writer gets", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const snapshots: unknown[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        agents: withCustomAgent({ name: "fixer", toolNames: ["read_file", "bash"] }),
        checkpointer: (context) => snapshots.push(context),
      }),
    );
    await dispatchTool.execute(
      { tasks: [{ role: "fixer", goal: "fix it" }] },
      dispatchOpts("t1", [{ role: "user", content: "hi" }]),
    );
    expect(snapshots).toHaveLength(1);
  });

  test("a custom agent holding no mutating tool takes no snapshot", async () => {
    const { fake } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const snapshots: unknown[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        agents: withCustomAgent({ name: "reviewer" }),
        checkpointer: (context) => snapshots.push(context),
      }),
    );
    await dispatchTool.execute(
      { tasks: [{ role: "reviewer", goal: "grade it" }] },
      dispatchOpts("t1", [{ role: "user", content: "hi" }]),
    );
    expect(snapshots).toEqual([]);
  });

  test("a custom agent holding bash serializes against a file-defined writer instead of racing it", async () => {
    const { fake, calls } = fakeChildLoop((_opts, index) => ({
      events: [{ type: "done", reason: "no-tool-call" }],
      before: index === 0 ? () => sleep(30) : undefined,
    }));
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        agents: withMutators({ name: "fixer", toolNames: ["read_file", "bash"] }),
      }),
    );
    await dispatchTool.execute(
      {
        tasks: [
          { role: "fixer", goal: "fix it" },
          { role: "writer", goal: "write" },
        ],
      },
      dispatchOpts("t1"),
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].startedAt).toBeGreaterThanOrEqual(calls[0].endedAt as number);
  });

  test("a custom agent's own model pin reaches resolveRole, and its name is what the roster sees", async () => {
    const { fake, calls } = fakeChildLoop(() => ({
      events: [{ type: "done", reason: "no-tool-call" }],
    }));
    const requests: unknown[] = [];
    const agents = withCustomAgent({
      name: "reviewer",
      request: { model: "claude-sonnet-5", provider: "anthropic", effort: "high" },
    });
    const events: ChildEventPayload[] = [];
    const dispatchTool = createDispatchTool(
      makeRuntime(fake, {
        agents,
        onChildEvent: (payload) => events.push(payload),
        resolveRole: (role, request) => {
          requests.push({ role, request });
          return {
            model: new MockLanguageModelV4({}),
            provider: "anthropic",
            modelId: "claude-sonnet-5",
            reasoningEffort: request?.effort,
            inherited: false,
          };
        },
      }),
    );
    await dispatchTool.execute(
      { tasks: [{ role: "reviewer", goal: "grade it" }] },
      dispatchOpts("t1"),
    );

    expect(requests).toContainEqual({
      role: "reviewer",
      request: { model: "claude-sonnet-5", provider: "anthropic", effort: "high" },
    });
    expect(calls[0].opts.reasoningEffort).toBe("high");
    expect(events[0]?.role).toBe("reviewer");
  });
});
