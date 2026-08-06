import { describe, expect, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { runLoop, type LoopEvent } from "../../src/loop/loop";
import { baseMessages, collect, makeTools, streamResult, textOnlyChunks, toolCallChunks, usage } from "./fixtures";

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
});
