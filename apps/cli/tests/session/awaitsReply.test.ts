import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { awaitsReply } from "../../src/session/awaitsReply";

describe("awaitsReply", () => {
  test("returns false for an empty session", () => {
    expect(awaitsReply([])).toBe(false);
  });

  test("returns true when the last message is an unanswered user message", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "do a task" }];
    expect(awaitsReply(messages)).toBe(true);
  });

  test("returns false when the last message is a final assistant text reply", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "do a task" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    expect(awaitsReply(messages)).toBe(false);
  });

  test("returns false for a bare-string final assistant reply", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "do a task" },
      { role: "assistant", content: "done" },
    ];
    expect(awaitsReply(messages)).toBe(false);
  });

  // loop.ts's "aborted" (mid-tool-batch cancel), "max-iterations", and "repeated-denials" done
  // reasons all end here — a fully-resolved-but-unconcluded turn, not a finished one.
  test("returns true when the last message is a tool-result row (interrupted mid agentic-loop)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "do a task" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "1", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "bash",
            output: { type: "execution-denied", reason: "cancelled" },
          },
        ],
      },
    ];
    expect(awaitsReply(messages)).toBe(true);
  });

  // Only reachable if the process died between loop.ts pushing the assistant row and running the
  // calls it named — treated the same as "owes a reply".
  test("returns true when the last message is an assistant message with unresolved tool calls", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "do a task" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "1", toolName: "bash", input: {} }],
      },
    ];
    expect(awaitsReply(messages)).toBe(true);
  });
});
