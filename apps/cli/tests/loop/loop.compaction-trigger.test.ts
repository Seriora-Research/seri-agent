import { describe, expect, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { isContextOverflowError } from "../../src/loop/compaction";
import { type LoopEvent, runLoop } from "../../src/loop/loop";
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
});
