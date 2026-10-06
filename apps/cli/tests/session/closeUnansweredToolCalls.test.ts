import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { closeUnansweredToolCalls } from "../../src/session/closeUnansweredToolCalls";

function call(id: string, toolName = "bash"): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName, input: {} }],
  };
}

function result(id: string, toolName = "bash"): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName,
        output: { type: "text", value: "ok" },
      },
    ],
  };
}

describe("closeUnansweredToolCalls", () => {
  test("is a no-op when every tool-call already has a result", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "go" }, call("c1"), result("c1")];
    expect(closeUnansweredToolCalls(messages)).toBe(false);
    expect(messages).toHaveLength(3);
  });

  test("inserts execution-denied results between an unanswered assistant call and a later user message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "sleep" },
      call("c1"),
      { role: "user", content: "continue" },
    ];
    expect(closeUnansweredToolCalls(messages)).toBe(true);
    expect(messages[2]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "bash",
          output: {
            type: "execution-denied",
            reason: 'Tool "bash" was cancelled by the user before it completed.',
          },
        },
      ],
    });
    expect(messages[3]).toEqual({ role: "user", content: "continue" });
  });

  test("closes only the missing call when one of two already has a result", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} },
          { type: "tool-call", toolCallId: "c2", toolName: "grep", input: {} },
        ],
      },
      result("c1"),
    ];
    expect(closeUnansweredToolCalls(messages)).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "c1", toolName: "bash" },
        {
          type: "tool-result",
          toolCallId: "c2",
          toolName: "grep",
          output: {
            type: "execution-denied",
            reason: 'Tool "grep" was cancelled by the user before it completed.',
          },
        },
      ],
    });
  });
});
