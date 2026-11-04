import { afterAll, describe, expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { type LoopEvent, runLoop } from "../../src/loop/loop";
import { withStallDeadlines } from "../../src/provider/stallDeadlines";
import { baseMessages, collect } from "../loop/fixtures";

const FAST = { firstByteMs: 300, idleMs: 300 } as const;

type Script =
  | "hang"
  | "headers-only"
  | "partial"
  | "complete-open"
  | "ok"
  | "429"
  | "anthropic-complete-open";

let scripts: Script[] = [];
const enc = new TextEncoder();
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const chunk = (delta: object, finish: string | null = null, usage?: object) => ({
  id: "c1",
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});
const USAGE = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 };
const sseHeaders = { "content-type": "text/event-stream" };

function openStream(
  write: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  close: boolean,
) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      write(controller);
      if (close) controller.close();
    },
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch(req) {
    const script = scripts.shift();
    switch (script) {
      case "hang":
        return new Promise<Response>(() => {});
      case "headers-only":
        return new Response(
          openStream(() => {}, false),
          { headers: sseHeaders },
        );
      case "partial":
        return new Response(
          openStream(
            (controller) => controller.enqueue(sse(chunk({ role: "assistant", content: "par" }))),
            false,
          ),
          { headers: sseHeaders },
        );
      case "complete-open":
        return new Response(
          openStream((controller) => {
            controller.enqueue(sse(chunk({ role: "assistant", content: "hello" })));
            controller.enqueue(sse(chunk({}, "stop", USAGE)));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
          }, false),
          { headers: sseHeaders },
        );
      case "ok":
        return new Response(
          openStream((controller) => {
            controller.enqueue(sse(chunk({ role: "assistant", content: "hello" })));
            controller.enqueue(sse(chunk({}, "stop", USAGE)));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
          }, true),
          { headers: sseHeaders },
        );
      case "429":
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after-ms": "10" },
        });
      case "anthropic-complete-open": {
        const ev = (type: string, data: object) =>
          enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        return new Response(
          openStream((controller) => {
            controller.enqueue(
              ev("message_start", {
                message: {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  model: "claude-x",
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 5, output_tokens: 1 },
                },
              }),
            );
            controller.enqueue(
              ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
            );
            controller.enqueue(
              ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } }),
            );
            controller.enqueue(ev("content_block_stop", { index: 0 }));
            controller.enqueue(
              ev("message_delta", {
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 5 },
              }),
            );
            controller.enqueue(ev("message_stop", {}));
          }, false),
          { headers: sseHeaders },
        );
      }
      default:
        return new Response(`unexpected script for ${req.url}`, { status: 500 });
    }
  },
});
afterAll(() => server.stop(true));

const base = `http://127.0.0.1:${server.port}/v1`;
const openai = () => createOpenAI({ apiKey: "k", baseURL: base }).chat("m");
const anthropic = () => createAnthropic({ apiKey: "k", baseURL: base })("claude-x");

function turn(model: LanguageModel): Promise<LoopEvent[]> {
  return collect(
    runLoop({
      model,
      tools: {},
      messages: baseMessages,
      permissionMode: "auto",
      signal: new AbortController().signal,
    }),
  );
}

async function run(model: () => LanguageModel, next: Script[]) {
  scripts = [...next];
  const events = await turn(withStallDeadlines(model(), FAST));
  return events.filter((event) => event.type !== "usage" && event.type !== "messages-updated");
}

describe("withStallDeadlines against a real OpenAI chat client", () => {
  test("a request that never answers is retried on a new connection, then the reply", async () => {
    const events = await run(openai, ["hang", "ok"]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    expect(events).toContainEqual({ type: "text-delta", text: "hello" });
  });

  test("headers with no body bytes are retried", async () => {
    const events = await run(openai, ["headers-only", "ok"]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("partial content then silence is an error with no retry and no done", async () => {
    const events = await run(openai, ["partial"]);
    expect(events).toContainEqual({ type: "text-delta", text: "par" });
    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", error: expect.stringMatching(/went silent for 300ms/) },
    ]);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  test("a retryable 429 still reaches the SDK's own retry", async () => {
    const events = await run(openai, ["429", "ok"]);
    expect(events).toContainEqual({ type: "retry", attempt: 1 });
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("an OpenAI [DONE] whose body stays open errors as idle, because the SDK emits no finish until the socket closes", async () => {
    const events = await run(openai, ["complete-open"]);
    expect(events).toContainEqual({ type: "text-delta", text: "hello" });
    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", error: expect.stringMatching(/went silent for 300ms/) },
    ]);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
});

describe("withStallDeadlines against a real Anthropic client", () => {
  test("message_stop with the body left open still ends the turn, because the SDK emits finish", async () => {
    const events = await run(anthropic, ["anthropic-complete-open"]);
    expect(events).toContainEqual({ type: "text-delta", text: "hello" });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });
});
