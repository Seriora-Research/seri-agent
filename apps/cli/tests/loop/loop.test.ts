import { describe, expect, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { type LoopEvent, runLoop } from "../../src/loop/loop";
import { quotaExhaustedLine } from "../../src/usage/quotaNotice";
import {
  baseMessages,
  collect,
  makeTools,
  reasoningThenTextChunks,
  streamResult,
  textOnlyChunks,
  toolCallChunks,
  usage,
} from "./fixtures";

describe("runLoop", () => {
  test("terminates on no-tool-call", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("Hello")),
    });
    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );
    expect(events).toContainEqual({ type: "text-delta", text: "Hello" });
    const update = events.find(
      (e): e is Extract<LoopEvent, { type: "messages-updated" }> => e.type === "messages-updated",
    );
    expect(update?.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    });
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("yields reasoning-delta before text-delta and does not put the thought in the assistant message", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(reasoningThenTextChunks("look at ROADMAP", "Hello")),
    });
    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );
    const types = events.map((event) => event.type);
    expect(types.indexOf("reasoning-delta")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("reasoning-delta")).toBeLessThan(types.indexOf("text-delta"));
    expect(events).toContainEqual({ type: "reasoning-delta", text: "look at ROADMAP" });
    expect(events).toContainEqual({ type: "text-delta", text: "Hello" });
    const update = events.find(
      (e): e is Extract<LoopEvent, { type: "messages-updated" }> => e.type === "messages-updated",
    );
    expect(update?.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    });
  });

  test("a text-only stream yields no reasoning-delta", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("Hello")),
    });
    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );
    expect(events.some((event) => event.type === "reasoning-delta")).toBe(false);
  });

  test("passes the system option through to streamText", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("Hello")),
    });
    await collect(
      runLoop({
        model,
        tools: {},
        messages: baseMessages,
        permissionMode: "auto",
        system: "You are seri, a coding agent.",
      }),
    );

    expect(model.doStreamCalls[0]?.prompt[0]).toEqual({
      role: "system",
      content: "You are seri, a coding agent.",
    });
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







  }, 60_000);

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
    expect(updates[2]?.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
    });
  });






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
      events = await collect(
        runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
      );
    } finally {
      console.error = originalError;
    }

    expect(printed).toEqual([]);


    expect(events).toEqual([{ type: "error", error: "Error: boom from provider" }]);
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });




  test("a non-Error provider error renders its payload instead of [object Object]", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw { error: { message: "tool call validation failed", type: "invalid_request_error" } };
      },
    });
    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent?.error).toContain("tool call validation failed");
    expect(errorEvent?.error).not.toBe("[object Object]");




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







            responseHeaders: { "retry-after-ms": "10" },
          });
        }
        return streamResult(textOnlyChunks("Hello"));
      },
    });

    const started = Date.now();
    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );
    const elapsed = Date.now() - started;

    expect(attempts).toBe(2);
    expect(events).toContainEqual({ type: "retry", attempt: 1 });
    expect(events).toContainEqual({ type: "text-delta", text: "Hello" });
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    expect(elapsed).toBeLessThan(1_500);
  });



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

    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );

    expect(attempts).toBe(1);
    expect(events.find((e) => e.type === "retry")).toBeUndefined();
    expect(events.find((e) => e.type === "error")?.error).toContain("invalid request");
  });

  test("a hosted quota 402 yields the hard-stop sentence, not the raw API error", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: "Payment Required",
          url: "https://api.seriora.ai/api/gateway/chat/completions",
          requestBodyValues: {},
          statusCode: 402,
          responseBody: JSON.stringify({ code: "allowance_exhausted" }),
        });
      },
    });
    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );
    expect(events.find((e) => e.type === "error")?.error).toBe(
      quotaExhaustedLine("included_spend"),
    );
    expect(events.some((e) => e.type === "error" && e.error.includes("AI_APICallError"))).toBe(
      false,
    );
  });

  test("a 402 that is not a hosted cap stays the provider error", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: "Payment Required",
          url: "https://api.seriora.ai/api/gateway/chat/completions",
          requestBodyValues: {},
          statusCode: 402,
          responseBody: JSON.stringify({ code: "unknown_plan" }),
        });
      },
    });
    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );
    const error = events.find((e) => e.type === "error")?.error;
    expect(error).toContain("Payment Required");
    expect(error).not.toContain("Hosted routes will not run");
  });

  test("emits the token usage of each completed model call", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" }, usage(120, 30))),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: makeTools(async () => "ok"),
        messages: baseMessages,
        permissionMode: "auto",
      }),
    );

    const usageEvents = events.filter(
      (e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage",
    );
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]?.usage.inputTokens).toBe(120);
    expect(usageEvents[0]?.usage.outputTokens).toBe(30);
    expect(usageEvents[1]?.usage.inputTokens).toBe(5);
    expect(usageEvents[1]?.usage.outputTokens).toBe(5);
  });

  test("populates the usage event's cost for an OpenRouter model from providerMetadata", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () =>
        streamResult([
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "Hello" },
          { type: "text-end", id: "1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: usage(100, 50),
            providerMetadata: {
              openrouter: {
                provider: "openrouter",
                usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.0031 },
              },
            },
          },
        ]),
    });

    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages: baseMessages,
        permissionMode: "auto",
        provider: "openrouter",
      }),
    );

    const usageEvent = events.find(
      (e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage",
    );
    expect(usageEvent?.cost).toEqual({
      amountUsd: 0.0031,
      status: "actual",
      source: "provider_cost_api",
    });
  });

  test("reports cost as unknown for a Groq-shaped call whose model isn't in the catalog", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("Hello")),
    });

    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages: baseMessages,
        permissionMode: "auto",
        provider: "groq",
        modelId: "some-unlisted-model",
        catalog: { fetchedAt: "2026-01-01T00:00:00.000Z", entries: [] },
      }),
    );

    const usageEvent = events.find(
      (e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage",
    );
    expect(usageEvent?.cost).toEqual({ amountUsd: undefined, status: "unknown", source: "none" });
  });

  test("leaves cost undefined when no provider/catalog opts are passed", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("Hello")),
    });

    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );

    const usageEvent = events.find(
      (e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage",
    );
    expect(usageEvent?.cost).toBeUndefined();
  });






  test("emits the usage of a call that streamed text and then failed mid-stream", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () =>
        streamResult([
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "partial answer" },
          { type: "error", error: new Error("upstream connection reset") },
          {
            type: "finish",
            finishReason: { unified: "error", raw: undefined },
            usage: usage(900, 7),
          },
        ]),
    });

    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );

    expect(events.find((e) => e.type === "error")?.error).toContain("upstream connection reset");
    const usageEvents = events.filter(
      (e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage",
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.usage.inputTokens).toBe(900);
    expect(usageEvents[0]?.usage.outputTokens).toBe(7);
  });





  test("a turn that streams text and then fails mid-stream still reports a cost, not an absent one", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () =>
        streamResult([
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "partial answer" },
          { type: "error", error: new Error("upstream connection reset") },
          {
            type: "finish",
            finishReason: { unified: "error", raw: undefined },
            usage: usage(900, 7),
          },
        ]),
    });

    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages: baseMessages,
        permissionMode: "auto",
        provider: "groq",
        modelId: "some-unlisted-model",
        catalog: { fetchedAt: "2026-01-01T00:00:00.000Z", entries: [] },
      }),
    );

    const usageEvent = events.find(
      (e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage",
    );



    expect(usageEvent?.cost).toEqual({ amountUsd: undefined, status: "unknown", source: "none" });
  });






  test("a call that produced no output reports the provider's error once and nothing else", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("connection refused");
      },
    });

    const events = await collect(
      runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto" }),
    );

    const errors = events.filter(
      (e): e is Extract<LoopEvent, { type: "error" }> => e.type === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("connection refused");
    expect(events.filter((e) => e.type === "usage")).toHaveLength(0);
  });

  test("compacts history once lastInputTokens crosses the threshold across a ~25-turn run, and a pre-compaction fact survives via the summary", async () => {
    const marker = "MARKER_FACT_777";
    const tools = makeTools(async (input: { path: string }) =>
      input.path === "marker.txt" ? marker : "ok",
    );

    const summaryObj = {
      goal: "keep working on the task",
      progress: `earlier the agent found: ${marker}`,
      blockers: "none",
      nextSteps: "continue",
    };

    const totalIterations = 25;
    const compactAtIteration = 11;
    const doStream = Array.from({ length: totalIterations }, (_, i) => {
      const inputTokens = i === compactAtIteration ? 6000 : 100;
      const path = i === 0 ? "marker.txt" : "a.txt";
      return streamResult(
        toolCallChunks(`call-${i}`, "write_file", { path }, usage(inputTokens, 10)),
      );
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
        preserveRecentTokens: 80,
      }),
    );

    const compactedEvents = events.filter(
      (e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted",
    );
    expect(compactedEvents).toHaveLength(1);
    expect(compactedEvents[0]?.evictedCount).toBeGreaterThan(0);
    expect(compactedEvents[0]?.tokensBefore).toBeGreaterThan(0);



    expect(compactedEvents[0]?.usage.inputTokens).toBe(20);
    expect(compactedEvents[0]?.usage.outputTokens).toBe(10);
    expect(model.doGenerateCalls).toHaveLength(1);

    expect(model.doStreamCalls).toHaveLength(totalIterations);
    const compactedAtCallIndex = compactAtIteration + 1;
    const beforePromptSize = model.doStreamCalls[compactAtIteration]?.prompt.length ?? 0;
    const afterPromptSize = model.doStreamCalls[compactedAtCallIndex]?.prompt.length ?? 0;
    expect(afterPromptSize).toBeLessThan(beforePromptSize);

    const finalPrompt = model.doStreamCalls.at(-1)?.prompt;
    expect(JSON.stringify(finalPrompt)).toContain(marker);
  });












  test("a retried compaction round-trip is reported as a retry event before the compacted event", async () => {
    const summaryObj = { goal: "g", progress: "p", blockers: "none", nextSteps: "continue" };

    const totalIterations = 25;
    const compactAtIteration = 11;
    const doStream = Array.from({ length: totalIterations }, (_, i) =>
      streamResult(
        toolCallChunks(
          `call-${i}`,
          "write_file",
          { path: "a.txt" },
          usage(i === compactAtIteration ? 6000 : 100, 10),
        ),
      ),
    );

    let generateAttempts = 0;
    const model = new MockLanguageModelV4({
      doStream,
      doGenerate: async () => {
        generateAttempts++;
        if (generateAttempts === 1) {
          throw new APICallError({
            message: "rate limit exceeded",
            url: "https://api.groq.com/openai/v1/chat/completions",
            requestBodyValues: {},
            statusCode: 429,


            responseHeaders: { "retry-after-ms": "10" },
          });
        }
        return {
          content: [{ type: "text", text: JSON.stringify(summaryObj) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: usage(20, 10),
          warnings: [],
        };
      },
    });

    const events = await collect(
      runLoop({
        model,
        tools: makeTools(async () => "ok"),
        messages: baseMessages,
        permissionMode: "auto",
        maxIterations: totalIterations,
        contextWindowSize: 10_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 80,
      }),
    );



    expect(generateAttempts).toBe(2);


    expect(events.filter((e) => e.type === "retry")).toEqual([{ type: "retry", attempt: 1 }]);
    expect(events.findIndex((e) => e.type === "retry")).toBeLessThan(
      events.findIndex((e) => e.type === "compacted"),
    );
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
  });



  test("a compaction that succeeds first time reports no retry", async () => {
    const summaryObj = { goal: "g", progress: "p", blockers: "none", nextSteps: "continue" };

    const totalIterations = 25;
    const compactAtIteration = 11;
    const doStream = Array.from({ length: totalIterations }, (_, i) =>
      streamResult(
        toolCallChunks(
          `call-${i}`,
          "write_file",
          { path: "a.txt" },
          usage(i === compactAtIteration ? 6000 : 100, 10),
        ),
      ),
    );

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
        tools: makeTools(async () => "ok"),
        messages: baseMessages,
        permissionMode: "auto",
        maxIterations: totalIterations,
        contextWindowSize: 10_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 80,
      }),
    );

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(events.find((e) => e.type === "retry")).toBeUndefined();
  });

  test("yields an error and keeps running uncompacted when compactMessages throws", async () => {
    const marker = "MARKER_FACT_777";
    const tools = makeTools(async (input: { path: string }) =>
      input.path === "marker.txt" ? marker : "ok",
    );

    const totalIterations = 25;
    const compactAtIteration = 11;
    const doStream = Array.from({ length: totalIterations }, (_, i) => {
      const inputTokens = i === compactAtIteration ? 6000 : 100;
      const path = i === 0 ? "marker.txt" : "a.txt";
      return streamResult(
        toolCallChunks(`call-${i}`, "write_file", { path }, usage(inputTokens, 10)),
      );
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
        preserveRecentTokens: 80,
      }),
    );

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent?.error).toContain("summary generation failed");
    expect(events.find((e) => e.type === "compacted")).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "done", reason: "max-iterations" });
    expect(model.doStreamCalls).toHaveLength(totalIterations);
  });





  describe("reasoningEffort re-validation against the resolved catalog entry", () => {
    const reasoningCatalog = {
      fetchedAt: "2026-01-01T00:00:00.000Z",
      entries: [
        {
          id: "reasoning-model",
          provider: "anthropic" as const,
          displayName: "Reasoning Model",
          family: "test",
          contextWindow: 1000,
          maxOutputTokens: 100,
          toolCall: true,
          reasoning: true,
          reasoningOptions: [{ type: "effort" as const, values: ["low", "medium", "high"] }],
          pricing: undefined,
        },
      ],
    };

    test("a tier legal for the resolved catalog entry is sent as providerOptions", async () => {
      const model = new MockLanguageModelV4({
        doStream: async () => streamResult(textOnlyChunks("Hello")),
      });

      await collect(
        runLoop({
          model,
          tools: {},
          messages: baseMessages,
          permissionMode: "auto",
          provider: "anthropic",
          modelId: "reasoning-model",
          catalog: reasoningCatalog,
          reasoningEffort: "medium",
        }),
      );

      expect(model.doStreamCalls[0]?.providerOptions).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 10000 } },
      });
    });




    test("a tier NOT legal for the resolved catalog entry is silently dropped, not sent", async () => {
      const model = new MockLanguageModelV4({
        doStream: async () => streamResult(textOnlyChunks("Hello")),
      });

      await collect(
        runLoop({
          model,
          tools: {},
          messages: baseMessages,
          permissionMode: "auto",
          provider: "anthropic",
          modelId: "reasoning-model",
          catalog: reasoningCatalog,
          reasoningEffort: "xhigh",
        }),
      );

      expect(model.doStreamCalls[0]?.providerOptions).toBeUndefined();
    });



    test("a tier set but the resolved model has no reasoningOptions at all is also dropped", async () => {
      const model = new MockLanguageModelV4({
        doStream: async () => streamResult(textOnlyChunks("Hello")),
      });

      await collect(
        runLoop({
          model,
          tools: {},
          messages: baseMessages,
          permissionMode: "auto",
          provider: "anthropic",
          modelId: "some-unlisted-model",
          catalog: reasoningCatalog,
          reasoningEffort: "medium",
        }),
      );

      expect(model.doStreamCalls[0]?.providerOptions).toBeUndefined();
    });
  });

  test("temperature and seed reach doStream on a seed-capable provider", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("Hello")),
    });
    await collect(
      runLoop({
        model,
        tools: {},
        messages: baseMessages,
        permissionMode: "auto",
        provider: "groq",
        temperature: 0,
        seed: 7,
      }),
    );
    expect(model.doStreamCalls[0]?.temperature).toBe(0);
    expect(model.doStreamCalls[0]?.seed).toBe(7);
  });

  test("seed is not sent on Anthropic even when configured — negative control", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("Hello")),
    });
    await collect(
      runLoop({
        model,
        tools: {},
        messages: baseMessages,
        permissionMode: "auto",
        provider: "anthropic",
        temperature: 0,
        seed: 7,
      }),
    );
    expect(model.doStreamCalls[0]?.temperature).toBe(0);
    expect(model.doStreamCalls[0]?.seed).toBeUndefined();
  });

  test("Codex subscription sends neither temperature nor seed", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("Hello")),
    });
    await collect(
      runLoop({
        model,
        tools: {},
        messages: baseMessages,
        permissionMode: "auto",
        provider: "openai",
        credential: "subscription",
        temperature: 0,
        seed: 7,
      }),
    );
    expect(model.doStreamCalls[0]?.temperature).toBeUndefined();
    expect(model.doStreamCalls[0]?.seed).toBeUndefined();
  });

  test("OpenRouter usage carries servedProvider from response metadata", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () =>
        streamResult([
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "Hello" },
          { type: "text-end", id: "1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: usage(100, 50),
            providerMetadata: {
              openrouter: {
                provider: "Anthropic",
                usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.01 },
              },
            },
          },
        ]),
    });
    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages: baseMessages,
        permissionMode: "auto",
        provider: "openrouter",
      }),
    );
    const usageEvent = events.find(
      (e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage",
    );
    expect(usageEvent?.servedProvider).toBe("Anthropic");
  });
});
