import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog } from "@seri/model-catalog";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LoopEvent, runLoop } from "../../src/loop/loop";
import { runLoop as realRunLoop } from "../../src/loop/loop";
import { DISPATCH_TOOL_NAME } from "../../src/provider/tools";
import {
  createDispatchTool,
  type DispatchResult,
  type SubagentRuntime,
} from "../../src/subagents/dispatch";
import { buildRoleToolSet } from "../../src/subagents/roles";
import { collect, streamResult, textOnlyChunks, toolCallChunks } from "../loop/fixtures";
import { fakeChildLoop } from "./fakeChildLoop";

type RunLoopOpts = Parameters<typeof runLoop>[0];

const execOpts = { toolCallId: "call-0", messages: [], context: {} };

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
  overrides: Partial<SubagentRuntime> = {},
): SubagentRuntime {
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

  test("same-path code tasks: the loser is stopped and re-run, and its write lands last", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "seri-dispatch-writer-overlap-"));
    const path = join(tmp, "a.txt");
    const winnerBarrier = makeBarrier();

    // The third writer-overlap case (a path claimed by an already-finished task does not trigger
    // another re-run) is demonstrated by the SAME test: the re-run (call index 2) succeeds without
    // conflicting again, because by then call 0 has already fully finished.
    const { fake, calls } = fakeChildLoop((opts, index) => {
      if (index === 0) {
        // The winner: claims the path, signals the loser, then stays "running" a little longer so
        // the loser's attempt genuinely overlaps with it.
        return {
          events: [{ type: "done", reason: "no-tool-call" }],
          before: async () => {
            await opts.tools.write_file?.execute?.({ path, content: "A" }, execOpts);
            winnerBarrier.resolve();
            await sleep(30);
          },
        };
      }
      if (index === 1) {
        // The loser's first attempt: conflicts and throws inside the wrapper (real code under
        // test); the throw is swallowed here the way loop.ts's own tool-call handling would
        // (loop.ts:531-546 turns it into an `error` event instead of a rejection).
        return {
          events: [usageEvent(5, 5)],
          before: async () => {
            await winnerBarrier.promise;
            try {
              await opts.tools.write_file?.execute?.({ path, content: "B" }, execOpts);
            } catch {
              // Expected: wrapWriteFile already recorded the conflict before throwing.
            }
          },
        };
      }
      // The re-run: the winner has fully finished by now, so this write does not conflict.
      return {
        events: [usageEvent(7, 3), { type: "done", reason: "no-tool-call" }],
        before: async () => {
          await opts.tools.write_file?.execute?.({ path, content: "B" }, execOpts);
        },
      };
    });

    const dispatchTool = createDispatchTool(makeRuntime(fake));
    const result = (await dispatchTool.execute(
      {
        tasks: [
          { role: "code", goal: "write A" },
          { role: "code", goal: "write B" },
        ],
      },
      dispatchOpts("t1"),
    )) as DispatchResult;

    expect(calls).toHaveLength(3);
    expect(calls[2].startedAt).toBeGreaterThanOrEqual(calls[0].endedAt as number);
    expect(readFileSync(path, "utf8")).toBe("B");
    expect(result.results[1].usage).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });

    rmSync(tmp, { recursive: true, force: true });
  });

  test("code tasks writing different paths run concurrently and are never serialized", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "seri-dispatch-writer-overlap-"));
    const pathA = join(tmp, "a.txt");
    const pathB = join(tmp, "b.txt");
    const { fake, calls } = fakeChildLoop((opts, index) => ({
      events: [{ type: "done", reason: "no-tool-call" }],
      before: async () => {
        const path = index === 0 ? pathA : pathB;
        await opts.tools.write_file?.execute?.(
          { path, content: index === 0 ? "A" : "B" },
          execOpts,
        );
      },
    }));

    const dispatchTool = createDispatchTool(makeRuntime(fake));
    await dispatchTool.execute(
      {
        tasks: [
          { role: "code", goal: "write A" },
          { role: "code", goal: "write B" },
        ],
      },
      dispatchOpts("t1"),
    );

    expect(calls).toHaveLength(2);
    expect(readFileSync(pathA, "utf8")).toBe("A");
    expect(readFileSync(pathB, "utf8")).toBe("B");
    rmSync(tmp, { recursive: true, force: true });
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
    expect(result.results[3].usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
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
});
