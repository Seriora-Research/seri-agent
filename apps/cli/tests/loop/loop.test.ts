import { describe, expect, test } from "bun:test";
import { simulateReadableStream, tool, type ModelMessage, type ToolSet } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runLoop, type LoopEvent } from "../../src/loop/loop";

function usage(inputTotal: number, outputTotal: number) {
  return {
    inputTokens: { total: inputTotal, noCache: inputTotal, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
  };
}

function textOnlyChunks(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: text },
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(5, 5) },
  ];
}

function toolCallChunks(
  toolCallId: string,
  toolName: string,
  input: unknown,
  tokenUsage = usage(5, 5),
): LanguageModelV4StreamPart[] {
  return [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: tokenUsage },
  ];
}

function streamResult(chunks: LanguageModelV4StreamPart[]) {
  return { stream: simulateReadableStream({ chunks }) };
}

async function collect(events: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function makeTools(execute: (input: { path: string }) => Promise<string>): ToolSet {
  return {
    write_file: tool({
      description: "write a file",
      inputSchema: z.object({ path: z.string() }),
      execute,
    }),
  };
}

const baseMessages: ModelMessage[] = [{ role: "user", content: "do the task" }];

describe("runLoop", () => {
  test("terminates on no-tool-call", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => streamResult(textOnlyChunks("Hello")) });
    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );
    expect(events).toContainEqual({ type: "text-delta", text: "Hello" });
    const update = events.find((e): e is Extract<LoopEvent, { type: "messages-updated" }> => e.type === "messages-updated");
    expect(update?.messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "Hello" }] });
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("passes the system option through to streamText", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => streamResult(textOnlyChunks("Hello")) });
    await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto", system: "You are Hesper, a coding agent." }),
    );

    expect(model.doStreamCalls[0]?.prompt[0]).toEqual({ role: "system", content: "You are Hesper, a coding agent." });
  });

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

    expect(events).toContainEqual({ type: "tool-call", name: "write_file", args: { path: "a.txt" } });
    expect(events).toContainEqual({ type: "tool-result", name: "write_file", result: "ok" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    expect(executed).toEqual([{ path: "a.txt" }]);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("ok");
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

    expect(events).toContainEqual({ type: "permission-denied", name: "write_file" });
    expect(events.find((e) => e.type === "tool-result")).toBeUndefined();
    expect(executed).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("max-iterations backstop trips after exactly the configured number of iterations", async () => {
    const tools = makeTools(async () => "ok");
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
    });
    const events = await collect(
      runLoop({ model, tools, messages: baseMessages, permissionMode: "auto", maxIterations: 3 }),
    );

    expect(model.doStreamCalls).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "done", reason: "max-iterations" });
  });

  test("token-budget backstop trips once cumulative usage exceeds the configured budget", async () => {
    const tools = makeTools(async () => "ok");
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" }, usage(60_000, 60_000))),
    });
    const events = await collect(
      runLoop({ model, tools, messages: baseMessages, permissionMode: "auto", tokenBudget: 100_000 }),
    );

    expect(model.doStreamCalls).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", reason: "token-budget" });
  });

  test("yields messages-updated after appending the assistant message and after appending tool results", async () => {
    const tools = makeTools(async () => "ok");
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }),
    );

    const updates = events.filter(
      (e): e is Extract<LoopEvent, { type: "messages-updated" }> => e.type === "messages-updated",
    );
    expect(updates).toHaveLength(3);
    expect(updates[0]?.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(updates[1]?.messages.at(-1)).toMatchObject({ role: "tool" });
    expect(updates[2]?.messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "Done" }] });
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

  test("compacts history once lastInputTokens crosses the threshold across a ~25-turn run, and a pre-compaction fact survives via the summary", async () => {
    const marker = "MARKER_FACT_777";
    const tools = makeTools(async (input: { path: string }) => (input.path === "marker.txt" ? marker : "ok"));

    const summaryObj = {
      goal: "keep working on the task",
      progress: `earlier the agent found: ${marker}`,
      blockers: "none",
      nextSteps: "continue",
    };

    const totalIterations = 25;
    const compactAtIteration = 11; // the doStream call whose usage crosses the threshold
    const doStream = Array.from({ length: totalIterations }, (_, i) => {
      const inputTokens = i === compactAtIteration ? 6000 : 100;
      const path = i === 0 ? "marker.txt" : "a.txt";
      return streamResult(toolCallChunks(`call-${i}`, "write_file", { path }, usage(inputTokens, 10)));
    });

    const model = new MockLanguageModelV4({
      doStream,
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify(summaryObj) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(20, 10),
        warnings: [],
      }),
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
        preserveRecentMessages: 6,
      }),
    );

    const compactedEvents = events.filter((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted");
    expect(compactedEvents).toHaveLength(1);
    expect(compactedEvents[0]?.evictedCount).toBeGreaterThan(0);
    expect(model.doGenerateCalls).toHaveLength(1);

    expect(model.doStreamCalls).toHaveLength(totalIterations);
    const compactedAtCallIndex = compactAtIteration + 1; // compaction runs before this iteration's streamText call
    const beforePromptSize = model.doStreamCalls[compactAtIteration]?.prompt.length ?? 0;
    const afterPromptSize = model.doStreamCalls[compactedAtCallIndex]?.prompt.length ?? 0;
    expect(afterPromptSize).toBeLessThan(beforePromptSize);

    const finalPrompt = model.doStreamCalls.at(-1)?.prompt;
    expect(JSON.stringify(finalPrompt)).toContain(marker);
  });

  test("yields an error and keeps running uncompacted when compactMessages throws", async () => {
    const marker = "MARKER_FACT_777";
    const tools = makeTools(async (input: { path: string }) => (input.path === "marker.txt" ? marker : "ok"));

    const totalIterations = 25;
    const compactAtIteration = 11; // the doStream call whose usage crosses the threshold
    const doStream = Array.from({ length: totalIterations }, (_, i) => {
      const inputTokens = i === compactAtIteration ? 6000 : 100;
      const path = i === 0 ? "marker.txt" : "a.txt";
      return streamResult(toolCallChunks(`call-${i}`, "write_file", { path }, usage(inputTokens, 10)));
    });

    const model = new MockLanguageModelV4({
      doStream,
      doGenerate: async () => {
        throw new Error("summary generation failed");
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
        preserveRecentMessages: 6,
      }),
    );

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent?.error).toContain("summary generation failed");
    expect(events.find((e) => e.type === "compacted")).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "done", reason: "max-iterations" });
    expect(model.doStreamCalls).toHaveLength(totalIterations);
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
          approvalPrompt: async () => true,
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
          approvalPrompt: async () => false,
        }),
      );

      expect(events).toContainEqual({ type: "permission-denied", name: "write_file" });
      expect(events.find((e) => e.type === "tool-result")).toBeUndefined();
      expect(executed).toEqual([]);
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

      expect(events).toContainEqual({ type: "permission-denied", name: "write_file" });
      expect(executed).toEqual([]);
    });
  });
});
