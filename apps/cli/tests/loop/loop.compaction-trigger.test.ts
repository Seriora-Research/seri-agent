import { describe, expect, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  isContextOverflowError,
  requestOutputCap,
  streamOutputCap,
} from "../../src/loop/compaction";
import { type LoopEvent, runLoop, usableInputTokens } from "../../src/loop/loop";
import {
  collect,
  makeTools,
  streamResult,
  textOnlyChunks,
  toolCallChunks,
  usage,
} from "./fixtures";

function summaryGenerate() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          goal: "g",
          progress: "p",
          blockers: "none",
          nextSteps: "continue",
        }),
      },
    ],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: usage(20, 10),
    warnings: [],
  };
}

function fatHistory(count: number, padChars: number): ModelMessage[] {
  const pad = "x".repeat(padChars);
  const out: ModelMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      i % 2 === 0
        ? { role: "user", content: `turn ${i} ${pad}` }
        : { role: "assistant", content: [{ type: "text", text: `reply ${i} ${pad}` }] },
    );
  }
  return out;
}

describe("isContextOverflowError", () => {
  test("matches context-window language in the message or cause", () => {
    expect(isContextOverflowError(new Error("context window exceeded"))).toBe(true);
    expect(isContextOverflowError(new Error("too many tokens in the request"))).toBe(true);
    expect(isContextOverflowError(new Error("maximum context length reached"))).toBe(true);
    expect(isContextOverflowError(new Error("context_length_exceeded"))).toBe(true);
    expect(isContextOverflowError(new Error("token limit exceeded"))).toBe(true);
    expect(
      isContextOverflowError(new Error("wrapper", { cause: new Error("context_length") })),
    ).toBe(true);
  });

  test("matches a 400 whose text is overflow language", () => {
    expect(
      isContextOverflowError(
        new APICallError({
          message: "this model's maximum context length is 128000 tokens",
          url: "https://api.example.com",
          requestBodyValues: {},
          statusCode: 400,
        }),
      ),
    ).toBe(true);
  });

  test("does not match a 429 or a generic 400", () => {
    expect(
      isContextOverflowError(
        new APICallError({
          message: "rate limit exceeded",
          url: "https://api.example.com",
          requestBodyValues: {},
          statusCode: 429,
        }),
      ),
    ).toBe(false);
    expect(
      isContextOverflowError(
        new APICallError({
          message: "invalid request",
          url: "https://api.example.com",
          requestBodyValues: {},
          statusCode: 400,
        }),
      ),
    ).toBe(false);
    expect(isContextOverflowError(new TypeError("broken"))).toBe(false);
  });
});

describe("runLoop compaction trigger", () => {
  test("compacts before the first streamText when the resumed history is already over threshold", async () => {
    const messages = fatHistory(12, 400);
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("ok")),
      doGenerate: async () => summaryGenerate(),
    });

    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages,
        permissionMode: "auto",
        maxIterations: 1,
        contextWindowSize: 2_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 200,
      }),
    );

    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.prompt.length).toBeLessThan(messages.length + 1);
  });

  test("does not compact an under-threshold resume", async () => {
    const messages: ModelMessage[] = [{ role: "user", content: "short" }];
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("ok")),
      doGenerate: async () => {
        throw new Error("summarizer must not run");
      },
    });

    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages,
        permissionMode: "auto",
        maxIterations: 1,
        contextWindowSize: 10_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 80,
      }),
    );

    expect(events.find((e) => e.type === "compacted")).toBeUndefined();
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  test("a context-overflow streamText failure compact-and-retries once", async () => {
    let streamAttempts = 0;
    const messages = fatHistory(12, 80);
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamAttempts++;
        if (streamAttempts === 1) {
          throw new Error("This model's maximum context length was exceeded");
        }
        return streamResult(textOnlyChunks("recovered"));
      },
      doGenerate: async () => summaryGenerate(),
    });

    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages,
        permissionMode: "auto",
        maxIterations: 1,
        contextWindowSize: 100_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 80,
      }),
    );

    expect(streamAttempts).toBe(2);
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(events.some((e) => e.type === "text-delta" && e.text === "recovered")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("a non-overflow streamText failure does not compact-and-retry", async () => {
    const messages = fatHistory(12, 80);
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new TypeError("socket hang up");
      },
      doGenerate: async () => {
        throw new Error("summarizer must not run");
      },
    });

    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages,
        permissionMode: "auto",
        maxIterations: 1,
        contextWindowSize: 100_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 80,
      }),
    );

    expect(events.find((e) => e.type === "compacted")).toBeUndefined();
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(events.find((e) => e.type === "error")?.error).toContain("socket hang up");
    expect(events.at(-1)).toEqual({
      type: "error",
      error: expect.stringContaining("socket hang up"),
    });
  });

  test("a second overflow after the retry fails as today", async () => {
    const messages = fatHistory(12, 80);
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("context_length_exceeded");
      },
      doGenerate: async () => summaryGenerate(),
    });

    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages,
        permissionMode: "auto",
        maxIterations: 1,
        contextWindowSize: 100_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 80,
      }),
    );

    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(model.doStreamCalls.length).toBe(2);
    const errors = events.filter(
      (e): e is Extract<LoopEvent, { type: "error" }> => e.type === "error",
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.at(-1)?.error).toContain("context_length");
  });

  test("compacts on a later iteration when history estimate grows past threshold even though usage inputTokens stay tiny", async () => {
    const fat = "x".repeat(8_000);
    const tools = makeTools(async () => fat);
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-0", "write_file", { path: "a.txt" }, usage(5, 5))),
        streamResult(textOnlyChunks("ok")),
      ],
      doGenerate: async () => summaryGenerate(),
    });

    const events = await collect(
      runLoop({
        model,
        tools,
        messages: fatHistory(6, 8),
        permissionMode: "auto",
        maxIterations: 2,
        contextWindowSize: 2_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 80,
      }),
    );

    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  test("compacts when assistant text, not a tool result, is what grows the estimate past threshold", async () => {
    const fatText = "x".repeat(8_000);
    const tools = makeTools(async () => "ok");
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult([
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: fatText },
          { type: "text-end", id: "1" },
          ...toolCallChunks("call-0", "write_file", { path: "a.txt" }, usage(5, 5)),
        ]),
        streamResult(textOnlyChunks("ok")),
      ],
      doGenerate: async () => summaryGenerate(),
    });

    const events = await collect(
      runLoop({
        model,
        tools,
        messages: fatHistory(6, 8),
        permissionMode: "auto",
        maxIterations: 2,
        contextWindowSize: 2_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 80,
      }),
    );

    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  test("does not compact again after splice when remaining history stays under threshold", async () => {
    const body = "x".repeat(400);
    const tools = makeTools(async () => body);
    const laterTurns = 8;
    const model = new MockLanguageModelV4({
      doStream: [
        ...Array.from({ length: laterTurns }, (_, i) =>
          streamResult(toolCallChunks(`call-${i}`, "write_file", { path: "a.txt" }, usage(5, 5))),
        ),
        streamResult(textOnlyChunks("done")),
      ],
      doGenerate: async () => summaryGenerate(),
    });

    const events = await collect(
      runLoop({
        model,
        tools,
        messages: fatHistory(12, 2_000),
        permissionMode: "auto",
        maxIterations: laterTurns + 1,
        contextWindowSize: 10_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 80,
      }),
    );

    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  test("compacts a second time after splice once the kept tail plus new growth recrosses threshold", async () => {
    const laterBody = "x".repeat(1_500);
    const tools = makeTools(async () => laterBody);
    const laterTurns = 8;
    const model = new MockLanguageModelV4({
      doStream: [
        ...Array.from({ length: laterTurns }, (_, i) =>
          streamResult(toolCallChunks(`call-${i}`, "write_file", { path: "a.txt" }, usage(5, 5))),
        ),
        streamResult(textOnlyChunks("done")),
      ],
      doGenerate: async () => summaryGenerate(),
    });

    const events = await collect(
      runLoop({
        model,
        tools,
        messages: fatHistory(12, 2_000),
        permissionMode: "auto",
        maxIterations: laterTurns + 1,
        contextWindowSize: 10_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 3_500,
      }),
    );

    expect(events.filter((e) => e.type === "compacted").length).toBeGreaterThanOrEqual(2);
    expect(model.doGenerateCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("onBeforeCompact runs before the summarizer evicts messages", async () => {
    const order: string[] = [];
    const messages = fatHistory(12, 400);
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("ok")),
      doGenerate: async () => {
        order.push("summarizer");
        return summaryGenerate();
      },
    });

    await collect(
      runLoop({
        model,
        tools: {},
        messages,
        permissionMode: "auto",
        maxIterations: 1,
        contextWindowSize: 2_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 200,
        onBeforeCompact: async () => {
          order.push("archivist");
        },
      }),
    );

    expect(order[0]).toBe("archivist");
    expect(order).toContain("summarizer");
  });

  test("subtracts maxOutputTokens so a mid-band history compacts; the same history does not without it", async () => {
    const messages = fatHistory(12, 1_200);
    const withOutput = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("ok")),
      doGenerate: async () => summaryGenerate(),
    });
    const compacted = await collect(
      runLoop({
        model: withOutput,
        tools: {},
        messages,
        permissionMode: "auto",
        maxIterations: 1,
        contextWindowSize: 10_000,
        maxOutputTokens: 4_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 200,
      }),
    );
    expect(compacted.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(withOutput.doGenerateCalls).toHaveLength(1);

    const windowOnly = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("ok")),
      doGenerate: async () => {
        throw new Error("summarizer must not run");
      },
    });
    const skipped = await collect(
      runLoop({
        model: windowOnly,
        tools: {},
        messages,
        permissionMode: "auto",
        maxIterations: 1,
        contextWindowSize: 10_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 200,
      }),
    );
    expect(skipped.filter((e) => e.type === "compacted")).toHaveLength(0);
    expect(windowOnly.doGenerateCalls).toHaveLength(0);
  });

  test("maxOutputTokens at or above the window does not shrink usable input", async () => {
    const messages = fatHistory(12, 1_200);
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("ok")),
      doGenerate: async () => {
        throw new Error("summarizer must not run");
      },
    });

    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages,
        permissionMode: "auto",
        maxIterations: 1,
        contextWindowSize: 10_000,
        maxOutputTokens: 10_000,
        compactionThreshold: 0.5,
        preserveRecentTokens: 200,
      }),
    );

    expect(events.filter((e) => e.type === "compacted")).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("catalog maxOutputTokens subtracts when opts omit window and output", async () => {
    const messages = fatHistory(12, 1_200);
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(textOnlyChunks("ok")),
      doGenerate: async () => summaryGenerate(),
    });
    const catalog = {
      fetchedAt: "2026-01-01T00:00:00.000Z",
      entries: [
        {
          id: "usable-input-model",
          provider: "groq" as const,
          displayName: "Usable Input Model",
          family: "test",
          contextWindow: 10_000,
          maxOutputTokens: 4_000,
          toolCall: true,
          reasoning: false,
          pricing: undefined,
        },
      ],
    };

    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages,
        permissionMode: "auto",
        maxIterations: 1,
        provider: "groq",
        modelId: "usable-input-model",
        catalog,
        compactionThreshold: 0.5,
        preserveRecentTokens: 200,
      }),
    );

    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

describe("usableInputTokens", () => {
  test("returns the advertised window when output is missing, zero, or at least the window", () => {
    expect(usableInputTokens(100, undefined)).toBe(100);
    expect(usableInputTokens(100, 0)).toBe(100);
    expect(usableInputTokens(100, 100)).toBe(100);
    expect(usableInputTokens(100, 200)).toBe(100);
  });

  test("subtracts a smaller positive output from the window", () => {
    expect(usableInputTokens(100, 30)).toBe(70);
  });
});

describe("streamOutputCap", () => {
  test("clamps an advertised cap above 32000", () => {
    expect(streamOutputCap(128_000)).toBe(32_000);
  });

  test("keeps an advertised cap at or below 32000", () => {
    expect(streamOutputCap(8_000)).toBe(8_000);
    expect(streamOutputCap(32_000)).toBe(32_000);
  });

  test("sends 32000 when advertised output is missing or not a positive finite number", () => {
    expect(streamOutputCap(undefined)).toBe(32_000);
    expect(streamOutputCap(0)).toBe(32_000);
    expect(streamOutputCap(-1)).toBe(32_000);
    expect(streamOutputCap(Number.NaN)).toBe(32_000);
  });
});

describe("requestOutputCap", () => {
  test("sends the advertised catalog cap without a 32000 clamp", () => {
    expect(requestOutputCap(128_000)).toBe(128_000);
    expect(requestOutputCap(8_000)).toBe(8_000);
  });

  test("sends 32000 when advertised output is missing or not a positive finite number", () => {
    expect(requestOutputCap(undefined)).toBe(32_000);
    expect(requestOutputCap(0)).toBe(32_000);
    expect(requestOutputCap(-1)).toBe(32_000);
    expect(requestOutputCap(Number.NaN)).toBe(32_000);
  });
});
