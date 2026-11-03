import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LanguageModel, ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { compactMessages } from "../../src/loop/compaction";
import { type LoopEvent, runLoop } from "../../src/loop/loop";
import { withRefusalRecovery } from "../../src/provider/refusal";
import { withStallDeadlines } from "../../src/provider/stallDeadlines";
import {
  baseMessages,
  collect,
  scriptedModel,
  streamResult,
  textOnlyChunks,
  usage,
} from "../loop/fixtures";

const FAST = { firstByteMs: 60, idleMs: 60 } as const;
const SLOW = { firstByteMs: 10_000, idleMs: 10_000 } as const;

function turn(model: LanguageModel, signal = new AbortController().signal): Promise<LoopEvent[]> {
  return collect(
    runLoop({ model, tools: {}, messages: baseMessages, permissionMode: "auto", signal }),
  );
}

const partial = textOnlyChunks("partial").slice(0, 2);

describe("withStallDeadlines in runLoop", () => {
  test("a request that never answers is retried once on a new request, then the turn ends with an error", async () => {
    const scripted = scriptedModel([{ kind: "hang" }, { kind: "hang" }]);
    const caller = new AbortController();
    const started = performance.now();

    const events = await turn(withStallDeadlines(scripted.model, FAST), caller.signal);
    const elapsed = performance.now() - started;

    expect(events).toEqual([
      { type: "error", error: expect.stringMatching(/no output within 60ms on two attempts/) },
    ]);
    expect(scripted.signals.map((signal) => signal.aborted)).toEqual([true, true]);
    expect(caller.signal.aborted).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(2 * FAST.firstByteMs - 10);
    expect(elapsed).toBeLessThan(2 * FAST.firstByteMs + 500);
  });

  test("a stream that opens and sends nothing is retried, and the retry leaves no trace", async () => {
    const scripted = scriptedModel([
      { kind: "silent" },
      { kind: "reply", parts: textOnlyChunks("hello") },
    ]);
    const caller = new AbortController();

    const events = await turn(withStallDeadlines(scripted.model, FAST), caller.signal);
    const bare = await turn(
      scriptedModel([{ kind: "reply", parts: textOnlyChunks("hello") }]).model,
    );

    expect(events).toEqual(bare);
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    expect(scripted.signals.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(caller.signal.aborted).toBe(false);
  });

  test("block starts and empty deltas are not output, so a stream of only those is retried", async () => {
    const scripted = scriptedModel([
      {
        kind: "stall-after",
        parts: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "" },
          { type: "tool-input-start", id: "t1", toolName: "write_file" },
        ],
      },
      { kind: "reply", parts: textOnlyChunks("hello") },
    ]);

    const events = await turn(withStallDeadlines(scripted.model, FAST));

    expect(scripted.signals).toHaveLength(2);
    expect(events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", text: "hello" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("a stream that goes silent after real output fails without a retry", async () => {
    const scripted = scriptedModel([{ kind: "stall-after", parts: partial }]);
    const caller = new AbortController();

    const events = await turn(withStallDeadlines(scripted.model, FAST), caller.signal);

    expect(scripted.signals).toHaveLength(1);
    expect(scripted.signals[0]?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(events[0]).toEqual({ type: "text-delta", text: "partial" });
    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", error: expect.stringMatching(/went silent for 60ms/) },
    ]);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  test("a provider error part is output, so it is not held for a first-byte retry", async () => {
    const scripted = scriptedModel([
      { kind: "stall-after", parts: [{ type: "error", error: new Error("provider exploded") }] },
    ]);

    const events = await turn(withStallDeadlines(scripted.model, FAST));

    expect(scripted.signals).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", error: expect.stringMatching(/provider exploded/) },
    ]);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  test("a stream that stalls after reasoning-start is not retried, because thinking has begun", async () => {
    const scripted = scriptedModel([
      { kind: "stall-after", parts: [{ type: "reasoning-start", id: "r1" }] },
    ]);

    const events = await turn(withStallDeadlines(scripted.model, FAST));

    expect(scripted.signals).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", error: expect.stringMatching(/went silent for 60ms/) },
    ]);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  test("a body that stays open after finish ends the turn normally", async () => {
    const scripted = scriptedModel([{ kind: "stall-after", parts: textOnlyChunks("hello") }]);

    const events = await turn(withStallDeadlines(scripted.model, FAST));

    expect(events).toContainEqual({ type: "text-delta", text: "hello" });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    expect(scripted.signals).toHaveLength(1);
  });

  test("a user abort while the request hangs is still done: aborted", async () => {
    const scripted = scriptedModel([{ kind: "hang" }]);
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 20);
    const started = performance.now();

    const events = await turn(withStallDeadlines(scripted.model, SLOW), caller.signal);

    expect(events).toEqual([{ type: "done", reason: "aborted" }]);
    expect(scripted.signals).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a user abort reaches the turn even when the provider ignores its abort signal", async () => {
    const model = new MockLanguageModelV4({ doStream: () => new Promise(() => {}) });
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 20);
    const started = performance.now();

    const events = await turn(withStallDeadlines(model, SLOW), caller.signal);

    expect(events).toEqual([{ type: "done", reason: "aborted" }]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a user abort while a started stream is silent is still done: aborted", async () => {
    const scripted = scriptedModel([{ kind: "stall-after", parts: partial }]);
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 20);

    const events = await turn(withStallDeadlines(scripted.model, SLOW), caller.signal);

    expect(events[0]).toEqual({ type: "text-delta", text: "partial" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(scripted.signals).toHaveLength(1);
  });

  test("a steady stream that outlasts both deadlines is unchanged", async () => {
    const steady = { firstByteMs: 150, idleMs: 150 } as const;
    const paced = () =>
      pacedModel(
        [
          [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "a" },
          ],
          [{ type: "text-delta", id: "1", delta: "b" }],
          [{ type: "text-delta", id: "1", delta: "c" }],
          [{ type: "text-delta", id: "1", delta: "d" }],
          [
            { type: "text-end", id: "1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: usage(5, 5),
            },
          ],
        ],
        50,
      );
    const started = performance.now();

    const wrapped = await turn(withStallDeadlines(paced(), steady));
    const elapsed = performance.now() - started;
    const bare = await turn(paced());

    expect(elapsed).toBeGreaterThan(steady.idleMs);
    expect(wrapped).toEqual(bare);
    expect(wrapped.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("a retryable 429 still reaches the SDK's own retry", async () => {
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

    const events = await turn(withStallDeadlines(model, FAST));

    expect(attempts).toBe(2);
    expect(events).toContainEqual({ type: "retry", attempt: 1 });
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("a refusal from a withRefusalRecovery model still ends the turn as model-refusal", async () => {
    const refusal = "I can't help with that.";
    const refusalContent = [{ type: "refusal", refusal }];
    const sse = [
      {
        type: "response.created",
        response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-5" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg_1", content: refusalContent },
      },
      {
        type: "response.completed",
        response: {
          usage: { input_tokens: 8, output_tokens: 4 },
          output: [{ type: "message", role: "assistant", id: "msg_1", content: refusalContent }],
        },
      },
    ];
    const body = sse.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const fetchImpl: typeof fetch = Object.assign(
      async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      { preconnect: () => {} },
    );
    const model = withRefusalRecovery(fetchImpl, (tapped) =>
      createOpenAI({ apiKey: "test-key", fetch: tapped })("gpt-5"),
    );

    const events = await turn(withStallDeadlines(model, FAST));

    expect(events.at(-1)).toEqual({ type: "done", reason: "model-refusal", text: refusal });
  });

  test("rejects a model id and any deadline that is not a positive finite number", () => {
    const { model } = scriptedModel([]);
    expect(() => withStallDeadlines("groq/some-model")).toThrow(TypeError);
    expect(() => withStallDeadlines(model, { firstByteMs: 0, idleMs: 60 })).toThrow(RangeError);
    expect(() => withStallDeadlines(model, { firstByteMs: 60, idleMs: -1 })).toThrow(RangeError);
    expect(() => withStallDeadlines(model, { firstByteMs: Number.NaN, idleMs: 60 })).toThrow(
      RangeError,
    );
    expect(() =>
      withStallDeadlines(model, { firstByteMs: 60, idleMs: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
  });
});

describe("withStallDeadlines in compactMessages", () => {
  const history: ModelMessage[] = [
    { role: "user", content: "do the task" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "write_file", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "write_file",
          output: { type: "json", value: "ok" },
        },
      ],
    },
    { role: "user", content: "keep me, recent tail" },
  ];
  const summary = {
    goal: "finish the task",
    progress: "wrote the file",
    blockers: "none",
    nextSteps: "continue",
  };

  test("a summarizer whose generate call never answers rejects with the stall after two requests", async () => {
    const scripted = scriptedModel([{ kind: "hang" }, { kind: "hang" }]);
    const caller = new AbortController();

    const error = await rejection(
      compactMessages(history, withStallDeadlines(scripted.model, FAST), 3, history, caller.signal),
    );

    expect(String(error)).toMatch(/no output within 60ms on two attempts/);
    expect(scripted.signals.map((signal) => signal.aborted)).toEqual([true, true]);
    expect(caller.signal.aborted).toBe(false);
  });

  test("a summarizer whose first generate call hangs compacts on the retry", async () => {
    const scripted = scriptedModel([
      { kind: "hang" },
      { kind: "reply", parts: textOnlyChunks(JSON.stringify(summary)) },
    ]);

    const result = await compactMessages(
      history,
      withStallDeadlines(scripted.model, FAST),
      3,
      history,
      new AbortController().signal,
    );

    expect(result.summary).toEqual(summary);
    expect(scripted.signals).toHaveLength(2);
  });

  test("the streaming summarizer reports the stall, not a generic no-output error", async () => {
    const scripted = scriptedModel([{ kind: "hang" }, { kind: "hang" }]);

    const error = await rejection(
      compactMessages(
        history,
        withStallDeadlines(scripted.model, FAST),
        3,
        history,
        new AbortController().signal,
        { stream: true },
      ),
    );

    expect(String(error)).toMatch(/no output within 60ms on two attempts/);
    expect(scripted.signals).toHaveLength(2);
  });
});

// bun's `expect(promise).rejects` ignores the test timeout while the promise is pending.
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function pacedModel(
  groups: readonly (readonly LanguageModelV4StreamPart[])[],
  gapMs: number,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          for (const group of groups) {
            await Bun.sleep(gapMs);
            for (const part of group) controller.enqueue(part);
          }
          controller.close();
        },
      }),
    }),
  });
}
