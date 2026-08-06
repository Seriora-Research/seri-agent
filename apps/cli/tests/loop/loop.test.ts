import { describe, expect, test } from "bun:test";
import { simulateReadableStream, tool, type ModelMessage, type ToolSet } from "ai";
import { APICallError, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runLoop, type LoopEvent } from "../../src/loop/loop";
import { toolDefinitions } from "../../src/provider/tools";
import { isBashAvailable } from "../../src/tools/bash";

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

function streamResult(chunks: LanguageModelV4StreamPart[], chunkDelayInMs?: number) {
  return { stream: simulateReadableStream({ chunks, chunkDelayInMs }) };
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
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto", system: "You are seri, a coding agent." }),
    );

    expect(model.doStreamCalls[0]?.prompt[0]).toEqual({ role: "system", content: "You are seri, a coding agent." });
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

  // Nothing else in this file omits maxIterations, so nothing else observed DEFAULT_MAX_ITERATIONS
  // and a revert of it was invisible to the suite. 500 mocked rounds rather than a smaller stand-in,
  // because a stand-in only pins the wiring and not the pinned number itself.
  test("with no maxIterations option the run stops at the 500-turn default", async () => {
    const tools = makeTools(async () => "ok");
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
    });
    const events = await collect(
      runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }),
    );

    expect(model.doStreamCalls).toHaveLength(500);
    expect(events.at(-1)).toEqual({ type: "done", reason: "max-iterations" });
  }, 30_000);

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

  // ai@7.0.48 defaults streamText's onError to `({ error }) => console.error(error)`
  // (dist/index.js:8792), so every provider failure put Bun's inspection of the whole error object
  // — request body, every response header including set-cookie, a node_modules stack — on stderr
  // from inside the generator AGENTS.md documents as never touching stdout/stdin. The same error
  // arrives on fullStream and is yielded below, so that print was a duplicate, not the only report.
  test("a provider error is surfaced as an event and never printed by the loop", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("boom from provider");
      },
    });
    const printed: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      printed.push(args[0]);
    };
    let events: LoopEvent[];
    try {
      events = await collect(runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }));
    } finally {
      console.error = originalError;
    }

    expect(printed).toEqual([]);
    // Proves the loop really ran and really reported the failure, so a green `printed` can only
    // mean the print was suppressed rather than that nothing happened.
    expect(events).toEqual([{ type: "error", error: "Error: boom from provider" }]);
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });

  // The payload is verbatim the `responseBody` of a live Groq 401 — a provider is free to reject
  // with a plain object, and String() of one is "[object Object]", which names neither the failure
  // nor its origin.
  test("a non-Error provider error renders its payload instead of [object Object]", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw { error: { message: "tool call validation failed", type: "invalid_request_error" } };
      },
    });
    const events = await collect(runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent?.error).toContain("tool call validation failed");
    expect(errorEvent?.error).not.toBe("[object Object]");

    // A bare string is the other non-Error shape in reach, and JSON.stringify wraps it in quotes:
    // a rejection of "ENOENT: no such file" rendered as `"ENOENT: no such file"`, quotes included,
    // both to the user and into the model's context.
    const stringModel = new MockLanguageModelV4({
      doStream: async () => {
        throw "ENOENT: no such file";
      },
    });
    const stringEvents = await collect(
      runLoop({ model: stringModel, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );
    expect(stringEvents.find((e) => e.type === "error")?.error).toBe("ENOENT: no such file");
  });

  // JSON.stringify throws on a cyclic value, and the site that renders a thrown tool failure is not
  // inside any try — a TypeError there escapes the generator and reaches cli.ts as an unhandled
  // rejection instead of as one error event. Measured against errorText written as a bare
  // JSON.stringify: this test failed with `TypeError: JSON.stringify cannot serialize cyclic
  // structures.` thrown out of collect(), with no `done` event at all.
  test("a tool that throws a circular non-Error value is reported instead of crashing the loop", async () => {
    const circular: { message: string; self?: unknown } = { message: "tool call validation failed" };
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
    const events = await collect(runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }));

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
    const events = await collect(runLoop({ model, tools, messages: baseMessages, permissionMode: "auto" }));

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

  // ai@7.0.48 already retries a failed model call before the failure ever surfaces: streamText
  // issues every call inside prepareRetries' wrapper (dist/index.js:9684) and that wrapper's
  // default is 2 retries (dist/index.js:2789). Nothing in this repo passed maxRetries, so the
  // retrying below was happening unstated and unobserved — this pins existing behaviour, it does
  // not introduce it. onLanguageModelCallStart is the only per-attempt hook the SDK exposes:
  // streamLanguageModelCall notifies it immediately before doStream (dist/index.js:8320) and the
  // whole of that function runs inside the retry closure, so a second notification within one
  // streamText call IS a retry. It carries neither the error nor the delay, which is why the event
  // carries neither.
  test("a retryable 429 is retried and reported as a retry event", async () => {
    let attempts = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        attempts++;
        if (attempts === 1) {
          throw new APICallError({
            message: "rate limit exceeded",
            url: "https://api.groq.com/openai/v1/chat/completions",
            requestBodyValues: {},
            statusCode: 429,
            // The SDK's first backoff is 2000 ms (dist/index.js:2747); getRetryDelayInMs replaces
            // it with a `retry-after-ms`/`retry-after` header when that is shorter
            // (dist/index.js:2718). The elapsed assertion below is what makes that honouring
            // visible rather than assumed: measured, this test runs in 79 ms with the header and
            // 2084 ms with it renamed away. The bound sits at 1500 ms rather than nearer the
            // measurement because this is a wall clock in CI: it only has to separate 79 from
            // 2084, and every ms of headroom below 2084 is free.
            responseHeaders: { "retry-after-ms": "10" },
          });
        }
        return streamResult(textOnlyChunks("Hello"));
      },
    });

    const started = Date.now();
    const events = await collect(runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }));
    const elapsed = Date.now() - started;

    expect(attempts).toBe(2);
    expect(events).toContainEqual({ type: "retry", attempt: 1 });
    expect(events).toContainEqual({ type: "text-delta", text: "Hello" });
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    expect(elapsed).toBeLessThan(1_500);
  });

  // The negative control for the test above: a `retry` event that appeared here would mean the
  // loop was announcing retries the SDK never performed.
  test("a non-retryable provider error is not retried and emits no retry event", async () => {
    let attempts = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        attempts++;
        throw new APICallError({
          message: "invalid request",
          url: "https://api.groq.com/openai/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 400,
        });
      },
    });

    const events = await collect(runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }));

    expect(attempts).toBe(1);
    expect(events.find((e) => e.type === "retry")).toBeUndefined();
    expect(events.find((e) => e.type === "error")?.error).toContain("invalid request");
  });

  test("emits the token usage of each completed model call", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" }, usage(120, 30))),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({ model, tools: makeTools(async () => "ok"), messages: baseMessages, permissionMode: "auto" }),
    );

    const usageEvents = events.filter((e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]?.usage.inputTokens).toBe(120);
    expect(usageEvents[0]?.usage.outputTokens).toBe(30);
    expect(usageEvents[1]?.usage.inputTokens).toBe(5);
    expect(usageEvents[1]?.usage.outputTokens).toBe(5);
  });

  // The exit that dropped 907 billed tokens. A call that streams text and then fails is charged
  // for the text it streamed, and this path returned before the usage was ever read — on the one
  // kind of turn whose cost is otherwise completely unaccounted for. Measured against ai@7.0.48:
  // consuming the `error` part and then awaiting result.usage resolves with the provider's own
  // numbers, so this is recoverable and was simply being discarded.
  test("emits the usage of a call that streamed text and then failed mid-stream", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () =>
        streamResult([
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "partial answer" },
          { type: "error", error: new Error("upstream connection reset") },
          { type: "finish", finishReason: { unified: "error", raw: undefined }, usage: usage(900, 7) },
        ]),
    });

    const events = await collect(runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }));

    expect(events.find((e) => e.type === "error")?.error).toContain("upstream connection reset");
    const usageEvents = events.filter((e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.usage.inputTokens).toBe(900);
    expect(usageEvents[0]?.usage.outputTokens).toBe(7);
  });

  // The other half of that exit, and the reason the await is caught rather than bare: when the
  // failure IS the call — doStream rejecting, nothing streamed — result.usage rejects with
  // AI_NoOutputGeneratedError instead of resolving. That rejection lands in the same try that
  // wraps the stream, so an uncaught await would report a SECOND, invented error on top of the
  // provider's real one and hand the user "No output generated" as the cause of their failure.
  test("a call that produced no output reports the provider's error once and nothing else", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("connection refused");
      },
    });

    const events = await collect(runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }));

    const errors = events.filter((e): e is Extract<LoopEvent, { type: "error" }> => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("connection refused");
    expect(events.filter((e) => e.type === "usage")).toHaveLength(0);
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
    // The summariser's own round-trip is billed like any other, and compactMessages has always
    // returned its usage — the loop dropped it, so no caller could see it. These are doGenerate's
    // usage(20, 10) above, which is the only place they can have come from.
    expect(compactedEvents[0]?.usage.inputTokens).toBe(20);
    expect(compactedEvents[0]?.usage.outputTokens).toBe(10);
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

  describe("abort", () => {
    // Every case here drives a real AbortController through runLoop, because the decisions this
    // stage had to make — discard the partial message, kill the in-flight tool, never start the
    // next one — are decisions, not implementation details, and an untested decision is whatever
    // the code happens to do.

    function twoToolCalls(): LanguageModelV4StreamPart[] {
      return [
        { type: "tool-call", toolCallId: "call-1", toolName: "write_file", input: JSON.stringify({ path: "a.txt" }) },
        { type: "tool-call", toolCallId: "call-2", toolName: "write_file", input: JSON.stringify({ path: "b.txt" }) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(5, 5) },
      ];
    }

    function toolRowOf(events: LoopEvent[]): { toolCalls: number; outputs: { type: string; reason?: string }[] } {
      const update = events
        .filter((e): e is Extract<LoopEvent, { type: "messages-updated" }> => e.type === "messages-updated")
        .at(-1);
      const toolMessage = update?.messages.at(-1);
      const assistant = update?.messages.at(-2);
      const content = Array.isArray(assistant?.content) ? assistant.content : [];
      return {
        toolCalls: content.filter((part) => part.type === "tool-call").length,
        outputs: (toolMessage?.content as { output: { type: string; reason?: string } }[]).map((part) => part.output),
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
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(5, 5) },
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
      const model = new MockLanguageModelV4({ doStream: async () => streamResult(textOnlyChunks("Hello")) });

      const events = await collect(
        runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto", signal: AbortSignal.abort() }),
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
          streamResult(toolCallChunks(`call-${i}`, "write_file", { path: "a.txt" }, usage(i === compactAtIteration ? 6000 : 100, 10))),
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
          preserveRecentMessages: 6,
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
    test.skipIf(!isBashAvailable())("a cancel does not wait for a bash command that ignores it", async () => {
      const controller = new AbortController();
      const model = new MockLanguageModelV4({
        doStream: async () =>
          streamResult([
            { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: JSON.stringify({ command: "sleep 30" }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(5, 5) },
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
        { type: "execution-denied", reason: 'Tool "bash" was cancelled by the user before it completed.' },
      ]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    }, 60_000);

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
          // readline and resolves false, which on its own is indistinguishable from a typed "n".
          approvalPrompt: async () => {
            controller.abort();
            return false;
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
