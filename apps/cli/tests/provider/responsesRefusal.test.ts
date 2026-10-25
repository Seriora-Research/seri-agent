import { createOpenAI } from "@ai-sdk/openai";
import { describe, expect, test } from "bun:test";
import { runLoop } from "../../src/loop/loop";
import { withRefusalRecovery } from "../../src/provider/refusal";
import { baseMessages, collect, makeTools } from "../loop/fixtures";

const SENTENCE = "I can't help with that.";

const created = {
  type: "response.created",
  response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-5" },
};

function completed(output?: unknown[]) {
  return {
    type: "response.completed",
    response: {
      usage: { input_tokens: 8, output_tokens: 4 },
      ...(output === undefined ? {} : { output }),
    },
  };
}

function messageAdded(id = "msg_1", index = 0) {
  return {
    type: "response.output_item.added",
    output_index: index,
    item: { type: "message", id },
  };
}

function messageDone(content?: unknown[], id = "msg_1", index = 0) {
  return {
    type: "response.output_item.done",
    output_index: index,
    item: {
      type: "message",
      id,
      ...(content === undefined ? {} : { content }),
    },
  };
}

function refusalPart(text: string) {
  return { type: "refusal", refusal: text };
}

function messageSnapshot(content: unknown[], id = "msg_1") {
  return { type: "message", role: "assistant", id, content };
}

function responsesFetch(events: readonly unknown[]): typeof fetch {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
}

async function run(events: readonly unknown[], tools: Parameters<typeof runLoop>[0]["tools"] = {}) {
  const model = withRefusalRecovery(responsesFetch(events), (fetchImpl) =>
    createOpenAI({ apiKey: "test-key", fetch: fetchImpl })("gpt-5"),
  );
  return collect(
    runLoop({
      model,
      tools,
      messages: baseMessages,
      permissionMode: "auto",
    }),
  );
}

describe("responses model refusal", () => {
  test("an output_item.done refusal sentence ends the turn as model-refusal", async () => {
    const events = await run([
      created,
      messageAdded(),
      messageDone([refusalPart(SENTENCE)]),
      completed([messageSnapshot([refusalPart(SENTENCE)])]),
    ]);

    expect(events.at(-1)).toEqual({ type: "done", reason: "model-refusal", text: SENTENCE });
    expect(events.some((event) => event.type === "text-delta" && event.text === SENTENCE)).toBe(
      false,
    );
    expect(events.some((event) => event.type === "tool-call")).toBe(false);
    expect(events.some((event) => event.type === "error" && event.error === SENTENCE)).toBe(false);
  });

  test("refusal.done wins over refusal.delta and is not concatenated", async () => {
    const events = await run([
      created,
      messageAdded(),
      { type: "response.refusal.delta", delta: "partial " },
      { type: "response.refusal.delta", delta: "piece" },
      { type: "response.refusal.done", refusal: SENTENCE },
      messageDone(),
      completed(),
    ]);

    expect(events.at(-1)).toEqual({ type: "done", reason: "model-refusal", text: SENTENCE });
    expect(events.filter((event) => event.type === "done")).toEqual([
      { type: "done", reason: "model-refusal", text: SENTENCE },
    ]);
  });

  test("reasoning-only output stays a no-tool-call", async () => {
    const events = await run([
      created,
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      {
        type: "response.reasoning_summary_part.added",
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        delta: "thinking",
      },
      {
        type: "response.reasoning_summary_part.done",
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      completed(),
    ]);

    expect(events).toContainEqual({ type: "reasoning-delta", text: "thinking" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("output_text only is a text-delta and then no-tool-call", async () => {
    const events = await run([
      created,
      messageAdded(),
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        delta: "hello",
      },
      messageDone([{ type: "output_text", text: "hello" }]),
      completed([messageSnapshot([{ type: "output_text", text: "hello" }])]),
    ]);

    expect(events).toContainEqual({ type: "text-delta", text: "hello" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("an empty message with no refusal part is no-tool-call", async () => {
    const events = await run([
      created,
      messageAdded(),
      messageDone([]),
      completed([messageSnapshot([])]),
    ]);

    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "done" && event.reason === "model-refusal")).toBe(
      false,
    );
  });

  test("a refusal part plus nonempty output_text is still model-refusal", async () => {
    const events = await run([
      created,
      messageAdded(),
      { type: "response.refusal.delta", delta: SENTENCE },
      { type: "response.refusal.done", refusal: SENTENCE },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        delta: "a normal answer",
      },
      messageDone([refusalPart(SENTENCE), { type: "output_text", text: "a normal answer" }]),
      completed([
        messageSnapshot([refusalPart(SENTENCE), { type: "output_text", text: "a normal answer" }]),
      ]),
    ]);

    expect(events).toContainEqual({ type: "text-delta", text: "a normal answer" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "model-refusal", text: SENTENCE });
    expect(events.some((event) => event.type === "done" && event.reason === "no-tool-call")).toBe(
      false,
    );
  });

  test("an empty refusal string part is still model-refusal", async () => {
    const events = await run([
      created,
      messageAdded(),
      messageDone([refusalPart("")]),
      completed([messageSnapshot([refusalPart("")])]),
    ]);

    expect(events.at(-1)).toEqual({ type: "done", reason: "model-refusal", text: "" });
  });

  test("a refusal plus a function call does not execute the tool", async () => {
    let executed = false;
    const events = await run(
      [
        created,
        messageAdded(),
        messageDone([refusalPart(SENTENCE)]),
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "write_file",
            arguments: JSON.stringify({ path: "a.txt" }),
          },
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "write_file",
            arguments: JSON.stringify({ path: "a.txt" }),
            status: "completed",
          },
        },
        completed([messageSnapshot([refusalPart(SENTENCE)])]),
      ],
      makeTools(async () => {
        executed = true;
        return "wrote";
      }),
    );

    expect(executed).toBe(false);
    expect(events.some((event) => event.type === "tool-call" || event.type === "tool-result")).toBe(
      false,
    );
    expect(events.at(-1)).toEqual({ type: "done", reason: "model-refusal", text: SENTENCE });
  });
});
