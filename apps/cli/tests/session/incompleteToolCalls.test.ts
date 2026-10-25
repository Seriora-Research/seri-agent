import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { dropIncompleteToolCalls } from "../../src/session/incompleteToolCalls";

const TRUNCATED = '{"path": "a.txt", "content": "print(1';

function result(
  id: string,
  output: { type: "text"; value: string } | { type: "json"; value: string } = {
    type: "text",
    value: "ok",
  },
  toolName = "write_file",
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName,
        output,
      },
    ],
  };
}

function poisoned(): ModelMessage[] {
  return [
    { role: "user", content: "write" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "cut",
          toolName: "write_file",
          input: TRUNCATED,
        },
      ],
    },
    result("cut", { type: "json", value: "wrote" }),
    { role: "user", content: "continue" },
  ];
}

describe("dropIncompleteToolCalls", () => {
  test("is a no-op on object inputs", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "obj",
            toolName: "write_file",
            input: { path: "a.txt" },
          },
        ],
      },
      result("obj"),
    ];
    const before = structuredClone(messages);
    expect(dropIncompleteToolCalls(messages)).toBe(false);
    expect(messages).toEqual(before);
  });

  test("drops a JSON string that never became an object", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "json",
            toolName: "write_file",
            input: '{"path":"b.txt"}',
          },
        ],
      },
      result("json"),
    ];
    expect(dropIncompleteToolCalls(messages)).toBe(true);
    expect(messages).toEqual([]);
  });

  test("drops a truncated tool-call and its matching tool-result", () => {
    const messages = poisoned();
    expect(dropIncompleteToolCalls(messages)).toBe(true);
    expect(messages).toEqual([
      { role: "user", content: "write" },
      { role: "user", content: "continue" },
    ]);
  });

  test("keeps a valid sibling in the same assistant message", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          {
            type: "tool-call",
            toolCallId: "ok",
            toolName: "write_file",
            input: { path: "ok.txt" },
          },
          {
            type: "tool-call",
            toolCallId: "cut",
            toolName: "write_file",
            input: TRUNCATED,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "ok",
            toolName: "write_file",
            output: { type: "text", value: "ok" },
          },
          {
            type: "tool-result",
            toolCallId: "cut",
            toolName: "write_file",
            output: { type: "json", value: "wrote" },
          },
        ],
      },
    ];
    expect(dropIncompleteToolCalls(messages)).toBe(true);
    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          {
            type: "tool-call",
            toolCallId: "ok",
            toolName: "write_file",
            input: { path: "ok.txt" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "ok",
            toolName: "write_file",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ]);
  });

  test("drops a string input, including one that is not truncated JSON", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "s1", toolName: "echo", input: "list the files" },
        ],
      },
      result("s1", { type: "text", value: "ok" }, "echo"),
    ];
    expect(dropIncompleteToolCalls(messages)).toBe(true);
    expect(messages).toEqual([]);
  });

  test("a second call is a no-op", () => {
    const messages = poisoned();
    expect(dropIncompleteToolCalls(messages)).toBe(true);
    const after = structuredClone(messages);
    expect(dropIncompleteToolCalls(messages)).toBe(false);
    expect(messages).toEqual(after);
  });

  test("a later object-shaped call that reuses the truncated id is kept", () => {
    const messages: ModelMessage[] = [
      ...poisoned(),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "cut",
            toolName: "write_file",
            input: { path: "ok.txt" },
          },
        ],
      },
      result("cut"),
    ];
    expect(dropIncompleteToolCalls(messages)).toBe(true);
    expect(messages).toEqual([
      { role: "user", content: "write" },
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "cut",
            toolName: "write_file",
            input: { path: "ok.txt" },
          },
        ],
      },
      result("cut"),
    ]);
  });

  test("a startIndex leaves an earlier fragment in the compacted prefix", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "cut",
            toolName: "write_file",
            input: TRUNCATED,
          },
        ],
      },
      result("cut"),
      { role: "user", content: "recent" },
      { role: "user", content: "LIVE_QUESTION_KEEP" },
    ];
    expect(dropIncompleteToolCalls(messages, 4)).toBe(false);
    expect(messages).toHaveLength(5);
    expect(messages[4]).toEqual({ role: "user", content: "LIVE_QUESTION_KEEP" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "cut", input: TRUNCATED }],
    });
  });
});
