// runLoop's tool half: dispatch, the permission gate, and cancellation. Split from
// loop.test.ts (the stream, its retries, its usage and provider errors) when that file passed
// 1000 lines; every test below is moved verbatim, none is new.
import { describe, expect, test } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { type ModelMessage, type ToolSet, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { type ApprovalAnswer, type LoopEvent, runLoop } from "../../src/loop/loop";
import { toolDefinitions } from "../../src/provider/tools";
import { isBashAvailable } from "../../src/tools/bash";
import {
  baseMessages,
  collect,
  makeTools,
  multiToolCallChunks,
  repeatedWriteCalls,
  streamResult,
  textOnlyChunks,
  toolCallChunks,
  usage,
} from "./fixtures";

describe("runLoop", () => {
  test("executes a tool call and appends the result to the next turn", async () => {
    const executed: unknown[] = [];
    const tools = makeTools(async (input) => {
      executed.push(input);
      return "ok";
    });
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }),
    );

    expect(events).toContainEqual({
      type: "tool-call",
      name: "write_file",
      args: { path: "a.txt" },
    });
    expect(events).toContainEqual({ type: "tool-result", name: "write_file", result: "ok" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    expect(executed).toEqual([{ path: "a.txt" }]);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("ok");
  });

  // Pins the ordering that the checkpoint wrapper's `rewindTo` depends on. runLoop pushes the
  // assistant message carrying the tool call immediately before the execute loop and pushes tool
  // results only after it, so at execute time the last message IS that assistant message and
  // `messages.length - 1` truncates to just before it. Truncating to `messages.length` instead
  // would leave a trailing assistant tool-call with no tool result, which is the
  // AI_MissingToolResultsError compaction.ts already goes out of its way to avoid. That coupling
  // lives here, in a test, rather than in a comment in the wrapper.
  test("the last message when a tool executes is the assistant message carrying that tool call", async () => {
    let captured: ModelMessage[] = [];
    const tools: ToolSet = {
      write_file: tool({
        description: "write a file",
        inputSchema: z.object({ path: z.string() }),
        execute: async (_input, options) => {
          captured = [...options.messages];
          return "ok";
        },
      }),
    };
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    await collect(runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }));

    const rewindTo = captured.length - 1;
    expect(captured[rewindTo]).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(captured[rewindTo])).toContain("call-1");
    expect(captured.slice(0, rewindTo)).toEqual(baseMessages);
  });

  test("coerces an undefined tool result (e.g. writeFile's void return) to a valid JSON value", async () => {
    const tools = makeTools(async () => undefined as unknown as string);
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }),
    );

    const update = events.find(
      (e): e is Extract<LoopEvent, { type: "messages-updated" }> =>
        e.type === "messages-updated" && e.messages.at(-1)?.role === "tool",
    );
    const toolMessage = update?.messages.at(-1);
    const roundTripped = JSON.parse(JSON.stringify(toolMessage));
    expect(roundTripped.content[0].output).toEqual({ type: "json", value: null });
  });

  test("read-only mode blocks a write tool instead of executing it", async () => {
    const executed: unknown[] = [];
    const tools = makeTools(async (input) => {
      executed.push(input);
      return "ok";
    });
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({ model, tools, messages: baseMessages, permissionMode: "read-only" }),
    );

    expect(events).toContainEqual({
      type: "permission-denied",
      name: "write_file",
      reason: "blocked",
    });
    expect(events.find((e) => e.type === "tool-result")).toBeUndefined();
    expect(executed).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("yields an error and continues when the model calls a tool that doesn't exist, instead of crashing", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "does_not_exist", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent?.error).toContain("does_not_exist");
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    expect(model.doStreamCalls).toHaveLength(2);
  });

  // The test above runs in auto, where every verdict is `allow` and the existence check is reached
  // whichever side of the gate it sits on. read-only is where the order shows: the gate classifies
  // a name it does not recognise as `write` (provider/tools.ts), so gating first answers a
  // hallucinated call with `deny-blocked` and hands the model "was not permitted to run (permission
  // mode: read-only) … tell the user to run /mode" plus "Do not retry this call" — a permission
  // diagnosis, a permission remedy and a retry ban, for a call no mode could ever have run.
  test("read-only reports a nonexistent tool as unknown, not as permission-denied", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "does_not_exist", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "read-only" }),
    );

    expect(events).toContainEqual({
      type: "error",
      error: 'Unknown tool "does_not_exist": no matching tool definition.',
    });
    expect(events.find((e) => e.type === "permission-denied")).toBeUndefined();
    // The row the model actually reads, which is where the wrong remedy would have landed.
    expect(toolResultOutputOf(events)).toEqual({
      type: "error-text",
      value: 'Unknown tool "does_not_exist": no matching tool definition.',
    });
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });

    function toolResultOutputOf(collected: LoopEvent[]): unknown {
      // Not `.at(-1)`: the errored call's turn is followed by a text-only turn, whose own
      // messages-updated has an assistant message last, not a tool one. Find the tool row itself.
      const toolMessage = collected
        .filter(
          (e): e is Extract<LoopEvent, { type: "messages-updated" }> =>
            e.type === "messages-updated",
        )
        .map((e) => e.messages.at(-1))
        .find((message) => message?.role === "tool");
      return (toolMessage?.content as { output: unknown }[] | undefined)?.[0]?.output;
    }
  });

  // The prompt throws instead of recording that it ran: if this order ever regresses, the failure
  // is the human being asked to approve a tool that cannot run, which is the thing prevented here.
  test("approve-each never asks the human to approve a tool that does not exist", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "does_not_exist", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages: baseMessages,
        permissionMode: "approve-each",
        approvalPrompt: () => {
          throw new Error("the human was asked to approve a tool with no definition");
        },
      }),
    );

    expect(events).toContainEqual({
      type: "error",
      error: 'Unknown tool "does_not_exist": no matching tool definition.',
    });
    expect(events.find((e) => e.type === "permission-denied")).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("yields an error and continues when a tool's execute throws, instead of crashing", async () => {
    const tools = makeTools(async () => {
      throw new Error("disk full");
    });
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }),
    );

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent?.error).toContain("write_file");
    expect(errorEvent?.error).toContain("disk full");

    const update = events.find(
      (e): e is Extract<LoopEvent, { type: "messages-updated" }> =>
        e.type === "messages-updated" && e.messages.at(-1)?.role === "tool",
    );
    const toolMessage = update?.messages.at(-1);
    expect(toolMessage?.content).toContainEqual(
      expect.objectContaining({ type: "tool-result", toolCallId: "call-1" }),
    );

    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    expect(model.doStreamCalls).toHaveLength(2);
  });

  // JSON.stringify throws on a cyclic value, and the site that renders a thrown tool failure is not
  // inside any try — a TypeError there escapes the generator and reaches cli.ts as an unhandled
  // rejection instead of as one error event. Measured against errorText written as a bare
  // JSON.stringify: this test failed with `TypeError: JSON.stringify cannot serialize cyclic
  // structures.` thrown out of collect(), with no `done` event at all.
  test("a tool that throws a circular non-Error value is reported instead of crashing the loop", async () => {
    const circular: { message: string; self?: unknown } = {
      message: "tool call validation failed",
    };
    circular.self = circular;
    const tools = makeTools(async () => {
      throw circular;
    });
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }),
    );

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent?.error).toContain('Tool "write_file" threw during execution');
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  // The tool-failure site puts errorText's output on stderr AND into the model's context as the
  // tool result, so an uncapped JSON.stringify of an arbitrary payload is the same shape as the
  // 66-line APICallError blob onError was silenced for. Nothing in reach throws a non-Error today
  // (see the cap's comment in loop.ts), so this pins the cap itself rather than a live failure.
  test("an oversized non-Error tool failure is truncated instead of serialised whole", async () => {
    const payload = { detail: "x".repeat(5_000) };
    const tools = makeTools(async () => {
      throw payload;
    });
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }),
    );

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent?.error).toContain('Tool "write_file" threw during execution');
    expect(errorEvent?.error).toContain("truncated");
    expect(errorEvent?.error?.length).toBeLessThan(700);
    // The head of the payload survives, so the cap shortens the report rather than replacing it.
    expect(errorEvent?.error).toContain('{"detail":"xxx');

    // The same string is what the model is billed to read on its next turn, which is the half the
    // stderr line above does not cover.
    const update = events.find(
      (e): e is Extract<LoopEvent, { type: "messages-updated" }> =>
        e.type === "messages-updated" && e.messages.at(-1)?.role === "tool",
    );
    expect(JSON.stringify(update?.messages.at(-1)).length).toBeLessThan(1_000);
  });

  describe("abort", () => {
    // Every case here drives a real AbortController through runLoop, because the decisions this
    // stage had to make — discard the partial message, kill the in-flight tool, never start the
    // next one — are decisions, not implementation details, and an untested decision is whatever
    // the code happens to do.

    function twoToolCalls(): LanguageModelV4StreamPart[] {
      return [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "write_file",
          input: JSON.stringify({ path: "a.txt" }),
        },
        {
          type: "tool-call",
          toolCallId: "call-2",
          toolName: "write_file",
          input: JSON.stringify({ path: "b.txt" }),
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: usage(5, 5),
        },
      ];
    }

    function toolRowOf(events: LoopEvent[]): {
      toolCalls: number;
      outputs: { type: string; reason?: string }[];
    } {
      const update = events
        .filter(
          (e): e is Extract<LoopEvent, { type: "messages-updated" }> =>
            e.type === "messages-updated",
        )
        .at(-1);
      const toolMessage = update?.messages.at(-1);
      const assistant = update?.messages.at(-2);
      const content = Array.isArray(assistant?.content) ? assistant.content : [];
      return {
        toolCalls: content.filter((part) => part.type === "tool-call").length,
        outputs: (toolMessage?.content as { output: { type: string; reason?: string } }[]).map(
          (part) => part.output,
        ),
      };
    }

    test("a cancel mid-stream discards the partial assistant message and ends done: aborted", async () => {
      const controller = new AbortController();
      const model = new MockLanguageModelV4({
        doStream: async () =>
          streamResult(
            [
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "half a " },
              { type: "text-delta", id: "1", delta: "sentence" },
              { type: "text-end", id: "1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: usage(5, 5),
              },
            ],
            20,
          ),
      });

      const events: LoopEvent[] = [];
      for await (const event of runLoop({
        model,
        tools: {},
        messages: baseMessages,
        permissionMode: "auto",
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === "text-delta") controller.abort();
      }

      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
      // Not an error: a user-initiated cancel is not a failure, and printEvent routes error to
      // stderr, which is where the user's pipe is not.
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      // No messages-updated at all, so the array the session holds is the pre-turn one, byte for
      // byte. This is the discard decision, asserted rather than assumed.
      expect(events.find((e) => e.type === "messages-updated")).toBeUndefined();
    });

    test("a cancel during tool execution still writes one tool-result row per tool call", async () => {
      const controller = new AbortController();
      const started: string[] = [];
      const tools: ToolSet = {
        write_file: tool({
          description: "write a file",
          inputSchema: z.object({ path: z.string() }),
          // Settles only when cancelled, which is what makes this a test of the in-flight case
          // rather than of a tool that happened to finish first. It answers an already-aborted
          // signal too, exactly as spawnCollect and runRipgrep now do — an abort landing while the
          // loop is suspended on its tool-call event arrives before execute is ever entered, and a
          // listener alone would wait for an event that has already been and gone.
          execute: async (input: { path: string }, options) => {
            started.push(input.path);
            return await new Promise<string>((_resolve, reject) => {
              const cancel = (): void => reject(new Error("cancelled"));
              options.abortSignal?.addEventListener("abort", cancel, { once: true });
              if (options.abortSignal?.aborted === true) cancel();
            });
          },
        }),
      };
      const model = new MockLanguageModelV4({ doStream: async () => streamResult(twoToolCalls()) });

      const events: LoopEvent[] = [];
      for await (const event of runLoop({
        model,
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === "tool-call") controller.abort();
      }

      // The mechanical proxy for AI_MissingToolResultsError: the provider rejects a persisted
      // assistant message whose tool calls are not all answered, so the counts have to match.
      const { toolCalls, outputs } = toolRowOf(events);
      expect(toolCalls).toBe(2);
      expect(outputs).toHaveLength(2);
      expect(outputs.every((output) => output.type === "execution-denied")).toBe(true);
      expect(started).toEqual(["a.txt"]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    });

    test("a tool is never started once the signal is already aborted", async () => {
      const controller = new AbortController();
      const started: string[] = [];
      const tools = makeTools(async (input) => {
        started.push(input.path);
        return "ok";
      });
      const model = new MockLanguageModelV4({ doStream: async () => streamResult(twoToolCalls()) });

      const events: LoopEvent[] = [];
      for await (const event of runLoop({
        model,
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        signal: controller.signal,
      })) {
        events.push(event);
        // The assistant message carrying the tool calls has just been pushed and the tool phase
        // has not begun, which is exactly the window this guard covers.
        if (event.type === "messages-updated") controller.abort();
      }

      // Half of "a half-written write_file is not a possible outcome": a cancelled write either
      // never started (here) or completed atomically (writeFile.ts's renameSync publish, covered
      // by its own tests). Neither half is sufficient alone.
      expect(started).toEqual([]);
      const { toolCalls, outputs } = toolRowOf(events);
      expect(toolCalls).toBe(2);
      expect(outputs).toHaveLength(2);
      expect(outputs.every((output) => output.type === "execution-denied")).toBe(true);
      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    });

    test("a signal that is already aborted opens no turn at all", async () => {
      // The top-of-iteration check's own test, and the reason it needed one: the compaction case
      // below was long assumed to be what covered it, and measurement said otherwise — that catch
      // returns, so the top check is never reached a second time and deleting it leaves the
      // compaction test green. This is the window that is actually its: nothing has run yet, so
      // there is no catch downstream to notice the abort, and without the check the loop would set
      // up a streamText call with a signal that is already spent.
      const model = new MockLanguageModelV4({
        doStream: async () => streamResult(textOnlyChunks("Hello")),
      });

      const events = await collect(
        runLoop({
          model,
          tools: {},
          messages: baseMessages,
          permissionMode: "auto",
          signal: AbortSignal.abort(),
        }),
      );

      expect(model.doStreamCalls).toHaveLength(0);
      expect(events).toEqual([{ type: "done", reason: "aborted" }]);
    });

    test("an abort landing after a completed tool phase opens no further turn", async () => {
      // The top-of-iteration check's other window, and the one that only the call count can see:
      // the tool ran and answered, so no abort check downstream of it fires, and without the check
      // at the top the loop opens a second streamText with a signal that is already spent — which
      // the SDK aborts, so the catch around the stream yields the very same done: aborted. Measured
      // with the check deleted: doStreamCalls goes to 2 and every other assertion here still
      // passes, which is why the count is not decoration.
      const controller = new AbortController();
      const executed: string[] = [];
      const tools = makeTools(async (input) => {
        executed.push(input.path);
        return "ok";
      });
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });

      const events: LoopEvent[] = [];
      for await (const event of runLoop({
        model,
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === "tool-result") controller.abort();
      }

      expect(executed).toEqual(["a.txt"]);
      expect(model.doStreamCalls).toHaveLength(1);
      // The completed call was answered normally, so this is not the unanswered-row path yielding
      // done: aborted — that path writes execution-denied.
      expect(toolRowOf(events).outputs.map((output) => output.type)).toEqual(["json"]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    });

    test("a cancel during compaction ends the turn instead of starting another", async () => {
      const controller = new AbortController();
      const tools = makeTools(async () => "ok");
      // Same shape as the compaction tests above, because the eviction boundary needs a real
      // history to land in: with only three messages findSafeEvictionBoundary returns null and
      // compaction never runs at all.
      const totalIterations = 25;
      const compactAtIteration = 11;
      const model = new MockLanguageModelV4({
        doStream: Array.from({ length: totalIterations }, (_, i) =>
          streamResult(
            toolCallChunks(
              `call-${i}`,
              "write_file",
              { path: "a.txt" },
              usage(i === compactAtIteration ? 6000 : 100, 10),
            ),
          ),
        ),
        // Stands in for generateText rejecting on an aborted signal, which is what the real
        // compaction round-trip does once it is handed one.
        doGenerate: async () => {
          controller.abort();
          throw new Error("The operation was aborted.");
        },
      });

      const events = await collect(
        runLoop({
          model,
          tools,
          messages: baseMessages,
          permissionMode: "auto",
          maxIterations: totalIterations,
          contextWindowSize: 10_000,
          compactionThreshold: 0.5,
          preserveRecentTokens: 80,
          signal: controller.signal,
        }),
      );

      // Stops at the turn that triggered the compaction rather than opening the next one: the
      // compaction catch yields an error and deliberately keeps going, so without an abort check
      // there it would fall straight into a fresh streamText call.
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(model.doStreamCalls).toHaveLength(compactAtIteration + 1);
      expect(events.find((e) => e.type === "compacted")).toBeUndefined();
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    });

    // The real bash tool, not a fake, because the defect this covers was entirely in the wiring:
    // every loop test above hands `execute` a signal that a hand-written fake reads, while
    // provider/tools.ts's bashTool discarded its second argument, so spawnCollect's `signal`
    // parameter had no production call site at all. `sleep` ignores the abort the way any real
    // command does — nothing inside it cooperates — so the only thing that can stop it is the kill
    // spawnCollect performs on being handed the signal. Guarded on bash's availability the same way
    // tests/tools/bash.test.ts's tree-kill case is.
    // spawnCollect.test.ts skips the kill-on-signal / cancelled-command cases on win32: Git Bash
    // does not reliably deliver abort to the tree, and `sleep 30` then runs to completion (~30s)
    // instead of being killed. This test is that same primitive through runLoop.
    test.skipIf(!isBashAvailable() || process.platform === "win32")(
      "a cancel does not wait for a bash command that ignores it",
      async () => {
        const controller = new AbortController();
        const model = new MockLanguageModelV4({
          doStream: async () =>
            streamResult([
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "bash",
                input: JSON.stringify({ command: "sleep 30" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: usage(5, 5),
              },
            ]),
        });

        const started = Date.now();
        const events: LoopEvent[] = [];
        for await (const event of runLoop({
          model,
          tools: { bash: toolDefinitions.bash },
          messages: baseMessages,
          permissionMode: "auto",
          signal: controller.signal,
        })) {
          events.push(event);
          if (event.type === "tool-call") controller.abort();
        }
        const elapsed = Date.now() - started;

        // Two assertions, because each fails on its own half of the bug. Unplumbed, the command ran
        // the full 30 s AND came back as an ordinary success — measured at 4072 ms and
        // `{"exitCode":0,"timedOut":false}` for a 4 s command with an already-aborted signal. The
        // margin is wide enough for a cold Windows shell spawn (tests/tools/bash.test.ts allows 15 s
        // for `echo hi`) and still an order of magnitude under 30 s.
        expect(elapsed).toBeLessThan(10_000);
        expect(events.find((e) => e.type === "tool-result")).toBeUndefined();
        expect(toolRowOf(events).outputs).toEqual([
          {
            type: "execution-denied",
            reason: 'Tool "bash" was cancelled by the user before it completed.',
          },
        ]);
        expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
      },
      60_000,
    );

    test("a cancel at the approval prompt is recorded as a cancel, not as a denial", async () => {
      const controller = new AbortController();
      const executed: string[] = [];
      const model = new MockLanguageModelV4({ doStream: async () => streamResult(twoToolCalls()) });

      const events = await collect(
        runLoop({
          model,
          tools: makeTools(async (input) => {
            executed.push(input.path);
            return "ok";
          }),
          messages: baseMessages,
          permissionMode: "approve-each",
          // Exactly what cli.ts's prompt does when Ctrl-C arrives while it is parked: it closes the
          // readline and resolves "no", which on its own is indistinguishable from a typed "n".
          approvalPrompt: async () => {
            controller.abort();
            return "no";
          },
          signal: controller.signal,
        }),
      );

      // The row count is not what discriminates here — it matches either way, because a denial also
      // writes a row and the pre-call guard then fills the rest. What the model reads is the reason,
      // and "was not permitted to run" would tell it a human refused the call it was interrupted in.
      const { toolCalls, outputs } = toolRowOf(events);
      expect(toolCalls).toBe(2);
      expect(outputs.map((output) => output.reason)).toEqual([
        'Tool "write_file" was cancelled by the user before it completed.',
        'Tool "write_file" was cancelled by the user before it completed.',
      ]);
      expect(events.find((e) => e.type === "permission-denied")).toBeUndefined();
      expect(executed).toEqual([]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    });
  });

  describe("approve-each", () => {
    test("executes the tool when the approval prompt approves", async () => {
      const executed: unknown[] = [];
      const tools = makeTools(async (input) => {
        executed.push(input);
        return "ok";
      });
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      const events = await collect(
        runLoop({
          model,
          tools,
          messages: baseMessages,
          permissionMode: "approve-each",
          approvalPrompt: async () => "once",
        }),
      );

      expect(events).toContainEqual({ type: "tool-result", name: "write_file", result: "ok" });
      expect(executed).toEqual([{ path: "a.txt" }]);
    });

    test("denies the tool when the approval prompt rejects", async () => {
      const executed: unknown[] = [];
      const tools = makeTools(async (input) => {
        executed.push(input);
        return "ok";
      });
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      const events = await collect(
        runLoop({
          model,
          tools,
          messages: baseMessages,
          permissionMode: "approve-each",
          approvalPrompt: async () => "no",
        }),
      );

      expect(events).toContainEqual({
        type: "permission-denied",
        name: "write_file",
        reason: "declined",
      });
      expect(events.find((e) => e.type === "tool-result")).toBeUndefined();
      expect(executed).toEqual([]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    });

    test("treats approve-each with no approvalPrompt as denied", async () => {
      const executed: unknown[] = [];
      const tools = makeTools(async (input) => {
        executed.push(input);
        return "ok";
      });
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      const events = await collect(
        runLoop({ model, tools, messages: baseMessages, permissionMode: "approve-each" }),
      );

      expect(events).toContainEqual({
        type: "permission-denied",
        name: "write_file",
        reason: "blocked",
      });
      expect(executed).toEqual([]);
    });

    test('"always" is not re-prompted for the same tool', async () => {
      const executed: unknown[] = [];
      const tools = makeTools(async (input) => {
        executed.push(input);
        return "ok";
      });
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(toolCallChunks("call-2", "write_file", { path: "b.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      let promptCalls = 0;
      const events = await collect(
        runLoop({
          model,
          tools,
          messages: baseMessages,
          permissionMode: "approve-each",
          approvalPrompt: async () => {
            promptCalls++;
            // A second prompt for write_file would mean "always" was not remembered — answering
            // "no" here turns that failure into a red assertion below instead of a green that
            // happened to pass only because both files got written anyway.
            return promptCalls === 1 ? "always" : "no";
          },
        }),
      );

      expect(promptCalls).toBe(1);
      expect(executed).toEqual([{ path: "a.txt" }, { path: "b.txt" }]);
      expect(events.filter((e) => e.type === "tool-allowed")).toEqual([
        { type: "tool-allowed", name: "write_file" },
      ]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    });

    test('"always" is scoped to the tool it was granted for', async () => {
      const tools: ToolSet = {
        write_file: tool({
          description: "write a file",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => "ok",
        }),
        bash: tool({
          description: "run a command",
          inputSchema: z.object({ command: z.string() }),
          execute: async () => "ok",
        }),
      };
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(toolCallChunks("call-2", "bash", { command: "echo hi" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      const promptedTools: string[] = [];
      await collect(
        runLoop({
          model,
          tools,
          messages: baseMessages,
          permissionMode: "approve-each",
          approvalPrompt: async (toolName) => {
            promptedTools.push(toolName);
            return "always";
          },
        }),
      );

      expect(promptedTools).toEqual(["write_file", "bash"]);
    });

    test("a seeded allowedTools skips the prompt entirely for that tool", async () => {
      const executed: unknown[] = [];
      const tools = makeTools(async (input) => {
        executed.push(input);
        return "ok";
      });
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      const events = await collect(
        runLoop({
          model,
          tools,
          messages: baseMessages,
          permissionMode: "approve-each",
          allowedTools: ["write_file"],
          approvalPrompt: async () => {
            throw new Error("must not be called: write_file was already seeded as allowed");
          },
        }),
      );

      expect(executed).toEqual([{ path: "a.txt" }]);
      expect(events.find((e) => e.type === "tool-allowed")).toBeUndefined();
    });

    test('"once" does not accumulate into a grant', async () => {
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(toolCallChunks("call-2", "write_file", { path: "b.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      let promptCalls = 0;
      const events = await collect(
        runLoop({
          model,
          tools: makeTools(async () => "ok"),
          messages: baseMessages,
          permissionMode: "approve-each",
          approvalPrompt: async () => {
            promptCalls++;
            return "once";
          },
        }),
      );

      expect(promptCalls).toBe(2);
      expect(events.find((e) => e.type === "tool-allowed")).toBeUndefined();
    });

    // approve-each, not read-only: a read-only block is now `reason: "blocked"` (the mode doing
    // its job) and never touches consecutiveDenials at all — see MAX_CONSECUTIVE_DENIALS. Only a
    // live "no" at the prompt is `reason: "declined"` and counts, so that is what this test needs
    // to produce repeatedly.
    test("repeated denials stop the run in materially fewer turns than the cap", async () => {
      const model = new MockLanguageModelV4({ doStream: repeatedWriteCalls(50) });
      const events = await collect(
        runLoop({
          model,
          tools: makeTools(async () => "ok"),
          messages: baseMessages,
          permissionMode: "approve-each",
          approvalPrompt: async () => "no",
          maxIterations: 50,
        }),
      );

      expect(events.at(-1)).toEqual({ type: "done", reason: "repeated-denials" });
      expect(events.filter((e) => e.type === "permission-denied")).toHaveLength(3);
      expect(model.doStreamCalls).toHaveLength(3);
      expect(model.doStreamCalls.length).toBeLessThan(50);

      // Resumability: the last tool-role message has one row per tool call the assistant message
      // before it made, so the next --resume does not hit AI_MissingToolResultsError.
      const lastUpdate = events
        .filter(
          (e): e is Extract<LoopEvent, { type: "messages-updated" }> =>
            e.type === "messages-updated",
        )
        .at(-1);
      const lastMessage = lastUpdate?.messages.at(-1);
      const assistant = lastUpdate?.messages.at(-2);
      const assistantCalls = Array.isArray(assistant?.content)
        ? assistant.content.filter((part) => part.type === "tool-call").length
        : 0;
      expect(lastMessage?.role).toBe("tool");
      expect((lastMessage?.content as unknown[]).length).toBe(assistantCalls);
    });

    // Symptom B from round 6's review: repeated-denials used to be reachable in read-only, where
    // NOTHING can ever be approved — three probes, cheap for a model to produce even three turns
    // apart, killed the run with the user's actual question unanswered. A read-only block is now
    // `reason: "blocked"`, never `"declined"`, so it never touches consecutiveDenials at all — this
    // run gets FIVE blocks in a row (more than MAX_CONSECUTIVE_DENIALS) and still runs to the
    // iteration cap rather than stopping early, proving the mode alone cannot trip the stop no
    // matter how many times it fires.
    test("read-only blocks never trip repeated-denials, however many times they happen", async () => {
      const model = new MockLanguageModelV4({ doStream: repeatedWriteCalls(5) });
      const events = await collect(
        runLoop({
          model,
          tools: makeTools(async () => "ok"),
          messages: baseMessages,
          permissionMode: "read-only",
          maxIterations: 5,
        }),
      );

      expect(events.at(-1)).toEqual({ type: "done", reason: "max-iterations" });
      expect(events.filter((e) => e.type === "permission-denied")).toHaveLength(5);
      expect(
        events
          .filter((e) => e.type === "permission-denied")
          .every((e) => e.type === "permission-denied" && e.reason === "blocked"),
      ).toBe(true);
      expect(model.doStreamCalls).toHaveLength(5);
    });

    // approve-each, not read-only: since round 6, a read-only block is `reason: "blocked"` and
    // never touches consecutiveDenials at all, so read-only could no longer demonstrate a reset
    // mattering — every denial in this test must be a live DECLINE to be a fact this counter
    // tracks in the first place. Reverted (round 5): the write-only reset this test used to pin
    // was itself reverted, because in read-only mode no write is ever approved, so a write-only
    // reset could never fire and the counter became "denied write attempts this run" instead of
    // "denied calls in a row" — a long, productive read-heavy session that merely probed a write a
    // few times, turns apart, would die here having done nothing wrong. An approved read now
    // resets the streak the same as any other approved call; see MAX_CONSECUTIVE_DENIALS for the
    // (theoretical, unmeasured) padding risk this accepts instead. Negative control: a "reset only
    // on an approved WRITE" rule (restore the `WRITE_TOOLS.has` guard around the reset in loop.ts)
    // would let the two declined writes after the glob add straight onto the two before it and
    // trip `repeated-denials` here instead.
    test("an allowed read resets the streak the same as any other approved call", async () => {
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(toolCallChunks("call-2", "glob", { pattern: "*" })),
          streamResult(toolCallChunks("call-3", "write_file", { path: "b.txt" })),
          streamResult(toolCallChunks("call-4", "write_file", { path: "c.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      const tools: ToolSet = {
        write_file: tool({
          description: "write a file",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => "ok",
        }),
        glob: tool({
          description: "list files",
          inputSchema: z.object({ pattern: z.string() }),
          execute: async () => [],
        }),
      };
      const events = await collect(
        runLoop({
          model,
          tools,
          messages: baseMessages,
          permissionMode: "approve-each",
          approvalPrompt: async () => "no",
        }),
      );

      expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
      expect(events.filter((e) => e.type === "permission-denied")).toHaveLength(3);
      // The glob itself still ran — an always-permitted read tool is not blocked by the streak.
      expect(events).toContainEqual({ type: "tool-result", name: "glob", result: [] });
    });

    // The guard that the threshold is not 1: "denies the tool when the approval prompt rejects"
    // above (a single DECLINED denial, then a text turn) already asserts `done: no-tool-call` —
    // mutating MAX_CONSECUTIVE_DENIALS to 1 turns that assertion red — without this test needing
    // to duplicate it. Not "read-only mode blocks a write tool instead of executing it": that
    // denial is `reason: "blocked"`, which never touches consecutiveDenials at all, so it would
    // stay green regardless of the threshold. Not "treats approve-each with no approvalPrompt as
    // denied" either: that one is ALSO `reason: "blocked"`, and asserts no `done` reason besides.

    test("an approval resets the consecutive-denial counter", async () => {
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(toolCallChunks("call-2", "write_file", { path: "b.txt" })),
          streamResult(toolCallChunks("call-3", "write_file", { path: "c.txt" })),
          streamResult(toolCallChunks("call-4", "write_file", { path: "d.txt" })),
          streamResult(toolCallChunks("call-5", "write_file", { path: "e.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      const answers: ApprovalAnswer[] = ["no", "no", "once", "no", "no"];
      let i = 0;
      const events = await collect(
        runLoop({
          model,
          tools: makeTools(async () => "ok"),
          messages: baseMessages,
          permissionMode: "approve-each",
          approvalPrompt: async () => answers[i++] ?? "no",
        }),
      );

      expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
      expect(
        events.find((e) => e.type === "done" && e.reason === "repeated-denials"),
      ).toBeUndefined();
    });

    // landmine 1's negative control: a cancel at the prompt must never be recorded as a denial.
    // Pinned above at "a cancel at the approval prompt is recorded as a cancel, not as a denial"
    // (the `describe("abort")` block) — one token changed (`return false` -> `return "no"`), every
    // assertion in that test byte-identical.

    test("the denial text names the permission mode and points at /mode", async () => {
      const blockedModel = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      const blockedEvents = await collect(
        runLoop({
          model: blockedModel,
          tools: makeTools(async () => "ok"),
          messages: baseMessages,
          permissionMode: "read-only",
        }),
      );
      const blockedReason = toolResultReasonOf(blockedEvents);

      const deniedModel = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      const deniedEvents = await collect(
        runLoop({
          model: deniedModel,
          tools: makeTools(async () => "ok"),
          messages: baseMessages,
          permissionMode: "approve-each",
          approvalPrompt: async () => "no",
        }),
      );
      const deniedReason = toolResultReasonOf(deniedEvents);

      expect(blockedReason).toContain("permission mode: read-only");
      expect(blockedReason).toContain("/mode");
      expect(deniedReason).toContain("permission mode: approve-each");
      // Landmine 3, pinned: a read-only block and a typed "n" are no longer byte-identical text.
      expect(blockedReason).not.toBe(deniedReason);

      function toolResultReasonOf(events: LoopEvent[]): string | undefined {
        // Not `.at(-1)`: the denied call's turn is followed by a text-only turn, whose own
        // messages-updated has an assistant message last, not a tool one. Find the tool row itself.
        const toolMessage = events
          .filter(
            (e): e is Extract<LoopEvent, { type: "messages-updated" }> =>
              e.type === "messages-updated",
          )
          .map((e) => e.messages.at(-1))
          .find((message) => message?.role === "tool");
        const row = (toolMessage?.content as { output: { reason?: string } }[] | undefined)?.[0];
        return row?.output.reason;
      }
    });
  });

  // Project hooks reach the loop as two callbacks and nothing else. The loop knows only that a
  // consumer may refuse a call and may have something to say after one — never that a hook, a
  // script or a hooks.yaml exists — so everything here is about WHEN the callbacks are consulted
  // and WHAT their answers turn into.
  describe("project hooks", () => {
    function oneWriteThenText(): MockLanguageModelV4 {
      return new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
    }

    function toolRowOutputs(events: LoopEvent[]): { type: string; reason?: string }[] {
      // Not `.at(-1)`: the tool turn is followed by a text-only turn whose own messages-updated
      // ends in an assistant message. Same shape the denial tests above use.
      const toolMessage = events
        .filter(
          (e): e is Extract<LoopEvent, { type: "messages-updated" }> =>
            e.type === "messages-updated",
        )
        .map((e) => e.messages.at(-1))
        .find((message) => message?.role === "tool");
      const content = (toolMessage?.content ?? []) as {
        output: { type: string; reason?: string };
      }[];
      return content.map((part) => part.output);
    }

    // The negative control, first on purpose: a suite that only ever watches a hook block cannot
    // tell a working gate from one that refuses everything. Identical to the block case below
    // except for what the callback returns.
    test("a PreToolUse callback that blocks nothing lets the call through", async () => {
      const executed: unknown[] = [];
      const prompted: string[] = [];
      const events = await collect(
        runLoop({
          model: oneWriteThenText(),
          tools: makeTools(async (input) => {
            executed.push(input);
            return "ok";
          }),
          messages: baseMessages,
          permissionMode: "approve-each",
          approvalPrompt: async (toolName) => {
            prompted.push(toolName);
            return "once";
          },
          onBeforeTool: async () => ({}),
        }),
      );

      expect(executed).toEqual([{ path: "a.txt" }]);
      expect(prompted).toEqual(["write_file"]);
      expect(events).toContainEqual({ type: "tool-result", name: "write_file", result: "ok" });
      expect(events.find((e) => e.type === "permission-denied")).toBeUndefined();
    });

    test("a PreToolUse block stops the call before the gate ever asks", async () => {
      const executed: unknown[] = [];
      const prompted: string[] = [];
      const events = await collect(
        runLoop({
          model: oneWriteThenText(),
          tools: makeTools(async (input) => {
            executed.push(input);
            return "ok";
          }),
          messages: baseMessages,
          permissionMode: "approve-each",
          approvalPrompt: async (toolName) => {
            prompted.push(toolName);
            return "once";
          },
          onBeforeTool: async () => ({ block: "nope" }),
        }),
      );

      expect(executed).toEqual([]);
      // The ordering claim, and the only assertion here that can see it: a block evaluated after
      // the gate would have parked a human on a question whose answer could not matter — and an
      // "always" to it would have written a grant that reaches around the hook on every later call.
      expect(prompted).toEqual([]);
      expect(events).toContainEqual({
        type: "permission-denied",
        name: "write_file",
        reason: "hook",
      });
      const [output] = toolRowOutputs(events);
      expect(output?.type).toBe("execution-denied");
      expect(output?.reason).toContain("nope");
    });

    // The determinism claim. "auto" is the mode that permits everything, and a hook a mode can
    // reach around is a hook nobody can rely on.
    test("a PreToolUse block still blocks in auto, the mode that permits everything", async () => {
      const executed: unknown[] = [];
      const events = await collect(
        runLoop({
          model: oneWriteThenText(),
          tools: makeTools(async (input) => {
            executed.push(input);
            return "ok";
          }),
          messages: baseMessages,
          permissionMode: "auto",
          onBeforeTool: async () => ({ block: "nope" }),
        }),
      );

      expect(executed).toEqual([]);
      expect(events).toContainEqual({
        type: "permission-denied",
        name: "write_file",
        reason: "hook",
      });
    });

    // The MAX_CONSECUTIVE_DENIALS boundary, in the shape "read-only blocks never trip
    // repeated-denials" above already pins for mode blocks: five in a row, comfortably past the
    // cap, and the run still reaches the iteration limit. Counted as denials these would stop it at
    // three with `repeated-denials` — a stop that means "a human said no three times" reported for
    // a path with no human in it at all.
    test("hook blocks never trip repeated-denials, however many times they happen", async () => {
      const model = new MockLanguageModelV4({ doStream: repeatedWriteCalls(5) });
      const events = await collect(
        runLoop({
          model,
          tools: makeTools(async () => "ok"),
          messages: baseMessages,
          permissionMode: "auto",
          maxIterations: 5,
          onBeforeTool: async () => ({ block: "nope" }),
        }),
      );

      expect(events.at(-1)).toEqual({ type: "done", reason: "max-iterations" });
      expect(events.filter((e) => e.type === "permission-denied")).toHaveLength(5);
      expect(model.doStreamCalls).toHaveLength(5);
    });

    test("PreToolUse errors are reported and the call still runs", async () => {
      const executed: unknown[] = [];
      const events = await collect(
        runLoop({
          model: oneWriteThenText(),
          tools: makeTools(async (input) => {
            executed.push(input);
            return "ok";
          }),
          messages: baseMessages,
          permissionMode: "auto",
          onBeforeTool: async () => ({ errors: ["lint could not be run", "audit timed out"] }),
        }),
      );

      expect(events.filter((e) => e.type === "error")).toEqual([
        { type: "error", error: "lint could not be run" },
        { type: "error", error: "audit timed out" },
      ]);
      // A hook that could not run has expressed no opinion, so it must never become a refusal.
      expect(executed).toEqual([{ path: "a.txt" }]);
      expect(events.find((e) => e.type === "permission-denied")).toBeUndefined();
    });

    test("PostToolUse runs after the call and its messages become error events", async () => {
      const seen: { subject: string; input: unknown; result: unknown }[] = [];
      const events = await collect(
        runLoop({
          model: oneWriteThenText(),
          tools: makeTools(async () => "wrote 3 lines"),
          messages: baseMessages,
          permissionMode: "auto",
          onAfterTool: async (subject, input, result) => {
            seen.push({ subject, input, result });
            return ["format rewrote a.txt"];
          },
        }),
      );

      // `result` too, not just the subject and the input: it is what the payload's `tool_response`
      // is built from, and a PostToolUse script written against Claude Code's contract reads that
      // field by name.
      expect(seen).toEqual([
        { subject: "write_file", input: { path: "a.txt" }, result: "wrote 3 lines" },
      ]);
      expect(events).toContainEqual({ type: "error", error: "format rewrote a.txt" });
      // The row survives: it is what keeps the session resumable, and a post hook consulted before
      // the push would be one cancel away from deleting it.
      expect(toolRowOutputs(events).map((output) => output.type)).toEqual(["json"]);
      const resultIndex = events.findIndex((e) => e.type === "tool-result");
      const errorIndex = events.findIndex((e) => e.type === "error");
      expect(resultIndex).toBeGreaterThanOrEqual(0);
      expect(errorIndex).toBeGreaterThan(resultIndex);
    });

    // A cancelled hook rejects, and before the catch that makes this pass the rejection escaped
    // runLoop entirely: no `done` event at all, and an assistant message whose tool call had no
    // matching tool-result row — AI_MissingToolResultsError on the next --resume. Measured, not
    // theorised, which is why it gets a test of its own rather than a line in another one.
    test.each([
      ["PreToolUse", "onBeforeTool"],
      ["PostToolUse", "onAfterTool"],
    ])("a cancelled %s hook still leaves the turn resumable", async (_event, optName) => {
      const controller = new AbortController();
      const reject = async () => {
        controller.abort();
        throw new Error("cancelled");
      };
      const events = await collect(
        runLoop({
          model: oneWriteThenText(),
          tools: makeTools(async () => "ok"),
          messages: baseMessages,
          permissionMode: "auto",
          signal: controller.signal,
          [optName]: reject,
        }),
      );

      expect(events).toContainEqual({ type: "done", reason: "aborted" });
      // Every tool call the assistant message carries has a row, which is the whole point: the
      // session has to be resumable after a Ctrl-C landing inside a hook.
      expect(toolRowOutputs(events)).toHaveLength(1);
    });

    // The cost control: with neither callback the turn is exactly what "executes a tool call and
    // appends the result to the next turn" (the first test in this file) already pins, assertion
    // for assertion. Nothing about the two new opts touches a session that has no hooks.
    test("a session with neither callback behaves exactly as it did before", async () => {
      const executed: unknown[] = [];
      const model = oneWriteThenText();
      const events = await collect(
        runLoop({
          model,
          tools: makeTools(async (input) => {
            executed.push(input);
            return "ok";
          }),
          messages: baseMessages,
          permissionMode: "auto",
        }),
      );

      expect(events).toContainEqual({
        type: "tool-call",
        name: "write_file",
        args: { path: "a.txt" },
      });
      expect(events).toContainEqual({ type: "tool-result", name: "write_file", result: "ok" });
      expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
      expect(executed).toEqual([{ path: "a.txt" }]);
      expect(model.doStreamCalls).toHaveLength(2);
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("ok");
      expect(events.find((e) => e.type === "error")).toBeUndefined();
    });
  });

  describe("parallel read-only tools", () => {
    const DELAY_MS = 80;

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function threeReadCalls(): LanguageModelV4StreamPart[] {
      return multiToolCallChunks([
        { toolCallId: "call-1", toolName: "read_file", input: { path: "a.txt" } },
        { toolCallId: "call-2", toolName: "grep", input: { pattern: "x", path: "." } },
        { toolCallId: "call-3", toolName: "glob", input: { pattern: "*.ts", path: "." } },
      ]);
    }

    function delayedReadTools(onStart: (name: string) => void): ToolSet {
      const delay = async (name: string) => {
        onStart(name);
        await sleep(DELAY_MS);
        return `${name}-ok`;
      };
      return {
        read_file: tool({
          description: "read",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => delay("read_file"),
        }),
        grep: tool({
          description: "grep",
          inputSchema: z.object({ pattern: z.string(), path: z.string() }),
          execute: async () => delay("grep"),
        }),
        glob: tool({
          description: "glob",
          inputSchema: z.object({ pattern: z.string(), path: z.string() }),
          execute: async () => delay("glob"),
        }),
      };
    }

    function toolMessageOutputs(events: LoopEvent[]): { type: string; reason?: string }[] {
      const toolMessage = events
        .filter(
          (e): e is Extract<LoopEvent, { type: "messages-updated" }> =>
            e.type === "messages-updated",
        )
        .map((e) => e.messages.at(-1))
        .find((message) => message?.role === "tool");
      const content = (toolMessage?.content ?? []) as {
        output: { type: string; reason?: string };
      }[];
      return content.map((part) => part.output);
    }

    test("three delayed read-only tools in one step overlap instead of summing wall time", async () => {
      const startedAt: number[] = [];
      const tools = delayedReadTools(() => startedAt.push(performance.now()));
      const model = new MockLanguageModelV4({
        doStream: [streamResult(threeReadCalls()), streamResult(textOnlyChunks("Done"))],
      });

      const t0 = performance.now();
      const events = await collect(
        runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }),
      );
      const elapsed = performance.now() - t0;

      expect(startedAt).toHaveLength(3);
      expect(Math.max(...startedAt) - Math.min(...startedAt)).toBeLessThan(40);
      // Sequential would be ~240ms of sleeps plus loop overhead. Negative control: this
      // assertion fails on the serial for-await execute loop (measured before the batching
      // change). Mutation that turns it red: await each execute before starting the next.
      expect(elapsed).toBeLessThan(160);
      expect(events.filter((e) => e.type === "tool-result")).toHaveLength(3);
      expect(toolMessageOutputs(events)).toHaveLength(3);
      expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    });

    test("two write_file calls in one step still do not overlap", async () => {
      const intervals: { start: number; end: number }[] = [];
      const tools = makeTools(async () => {
        const start = performance.now();
        await sleep(30);
        intervals.push({ start, end: performance.now() });
        return "ok";
      });
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(
            multiToolCallChunks([
              { toolCallId: "call-1", toolName: "write_file", input: { path: "a.txt" } },
              { toolCallId: "call-2", toolName: "write_file", input: { path: "b.txt" } },
            ]),
          ),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      await collect(runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }));
      expect(intervals).toHaveLength(2);
      const first = intervals[0];
      const second = intervals[1];
      if (first === undefined || second === undefined) {
        throw new Error("expected two write intervals");
      }
      expect(second.start).toBeGreaterThanOrEqual(first.end);
    });

    test("a write_file between two reads is a barrier", async () => {
      const marks: { name: string; at: "start" | "end"; t: number }[] = [];
      const stamp = (name: string, at: "start" | "end") => {
        marks.push({ name, at, t: performance.now() });
      };
      const tools: ToolSet = {
        read_file: tool({
          description: "read",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => {
            stamp("read_file", "start");
            await sleep(DELAY_MS);
            stamp("read_file", "end");
            return "r";
          },
        }),
        write_file: tool({
          description: "write",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => {
            stamp("write_file", "start");
            await sleep(10);
            stamp("write_file", "end");
            return "w";
          },
        }),
        grep: tool({
          description: "grep",
          inputSchema: z.object({ pattern: z.string(), path: z.string() }),
          execute: async () => {
            stamp("grep", "start");
            await sleep(DELAY_MS);
            stamp("grep", "end");
            return "g";
          },
        }),
      };
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(
            multiToolCallChunks([
              { toolCallId: "call-1", toolName: "read_file", input: { path: "a.txt" } },
              { toolCallId: "call-2", toolName: "write_file", input: { path: "b.txt" } },
              { toolCallId: "call-3", toolName: "grep", input: { pattern: "x", path: "." } },
            ]),
          ),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      await collect(runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }));
      function timeAt(name: string, at: "start" | "end"): number {
        const mark = marks.find((m) => m.name === name && m.at === at);
        if (mark === undefined) throw new Error(`missing ${name} ${at}`);
        return mark.t;
      }
      expect(timeAt("write_file", "start")).toBeGreaterThanOrEqual(timeAt("read_file", "end"));
      expect(timeAt("grep", "start")).toBeGreaterThanOrEqual(timeAt("write_file", "end"));
    });

    test("a cancel on the first read tool-call does not start the rest and still pairs every row", async () => {
      const controller = new AbortController();
      const started: string[] = [];
      const abortingExecute = (name: string) =>
        tool({
          description: name,
          inputSchema: z.object({ path: z.string().optional(), pattern: z.string().optional() }),
          execute: async (_input, options) => {
            started.push(name);
            return await new Promise<string>((_resolve, reject) => {
              const cancel = (): void => reject(new Error("cancelled"));
              options.abortSignal?.addEventListener("abort", cancel, { once: true });
              if (options.abortSignal?.aborted === true) cancel();
            });
          },
        });
      const tools: ToolSet = {
        read_file: abortingExecute("read_file"),
        grep: abortingExecute("grep"),
        glob: abortingExecute("glob"),
      };
      const model = new MockLanguageModelV4({
        doStream: async () => streamResult(threeReadCalls()),
      });
      const events: LoopEvent[] = [];
      for await (const event of runLoop({
        model,
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === "tool-call") controller.abort();
      }
      expect(started).toEqual(["read_file"]);
      expect(toolMessageOutputs(events)).toHaveLength(3);
      expect(toolMessageOutputs(events).every((output) => output.type === "execution-denied")).toBe(
        true,
      );
      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    });

    test("a PreToolUse block on the middle read never executes it and still runs the others", async () => {
      const started: string[] = [];
      const tools = delayedReadTools((name) => started.push(name));
      const model = new MockLanguageModelV4({
        doStream: [streamResult(threeReadCalls()), streamResult(textOnlyChunks("Done"))],
      });
      const events = await collect(
        runLoop({
          model,
          tools,
          messages: baseMessages,
          permissionMode: "auto",
          onBeforeTool: async (subject) => (subject === "grep" ? { block: "nope" } : {}),
        }),
      );
      expect(started.sort()).toEqual(["glob", "read_file"]);
      expect(events).toContainEqual({
        type: "permission-denied",
        name: "grep",
        reason: "hook",
      });
      expect(events.filter((e) => e.type === "tool-result")).toHaveLength(2);
      expect(toolMessageOutputs(events)).toHaveLength(3);
    });

    test("tool-call events stay paired: no second tool-call before the first result", async () => {
      const tools = delayedReadTools(() => {});
      const model = new MockLanguageModelV4({
        doStream: [streamResult(threeReadCalls()), streamResult(textOnlyChunks("Done"))],
      });
      const events = await collect(
        runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }),
      );
      const names = events
        .filter(
          (e): e is Extract<LoopEvent, { type: "tool-call" | "tool-result" }> =>
            e.type === "tool-call" || e.type === "tool-result",
        )
        .map((e) => e.type);
      expect(names).toEqual([
        "tool-call",
        "tool-result",
        "tool-call",
        "tool-result",
        "tool-call",
        "tool-result",
      ]);
    });
  });
});
