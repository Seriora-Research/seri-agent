import { describe, expect, test } from "bun:test";
import type { JSONValue, ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { compactMessages, findSafeEvictionBoundary } from "../../src/loop/compaction";
import { streamResult, textOnlyChunks } from "./fixtures";

function usage(inputTotal: number, outputTotal: number) {
  return {
    inputTokens: {
      total: inputTotal,
      noCache: inputTotal,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
  };
}

function assistantToolCallMsg(id: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "write_file", input: {} }],
  };
}

function toolResultMsg(id: string, value: JSONValue): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "write_file",
        output: { type: "json", value },
      },
    ],
  };
}

// One leading user message, then `pairs` adjacent {assistant tool-call, tool result} pairs.
function buildAlternatingMessages(pairs: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "user", content: "do the task" }];
  for (let i = 0; i < pairs; i++) {
    messages.push(assistantToolCallMsg(`call-${i}`), toolResultMsg(`call-${i}`, "ok"));
  }
  return messages;
}

describe("findSafeEvictionBoundary", () => {
  test("never returns a boundary pointing at a tool message, across every preserveRecentMessages value", () => {
    const messages = buildAlternatingMessages(10);
    for (let preserve = 0; preserve <= messages.length; preserve++) {
      const boundary = findSafeEvictionBoundary(messages, preserve);
      if (boundary === null) continue;
      expect(messages[boundary]?.role).not.toBe("tool");
    }
  });

  test("walks forward past a tool message when the naive cut would split a tool-call/tool-result pair", () => {
    const messages = buildAlternatingMessages(10);
    const candidateIndex = 6; // even index -> lands on a tool message
    expect(messages[candidateIndex]?.role).toBe("tool");
    const preserve = messages.length - candidateIndex;

    const boundary = findSafeEvictionBoundary(messages, preserve);

    expect(boundary).toBe(candidateIndex + 1);
    expect(messages[boundary as number]?.role).toBe("assistant");
  });

  test("returns null when fewer than minEvictable messages would be evicted", () => {
    const messages = buildAlternatingMessages(10);
    expect(findSafeEvictionBoundary(messages, messages.length)).toBeNull();
  });
});

describe("compactMessages", () => {
  test("replaces the evicted span with one synthetic summary message and keeps the tail, surviving a marker fact", async () => {
    const marker = "MARKER_SECRET_FACT_42";
    const messages: ModelMessage[] = [
      { role: "user", content: "do the task" },
      assistantToolCallMsg("call-1"),
      toolResultMsg("call-1", marker),
      { role: "user", content: "keep me, recent tail" },
    ];
    const evictBoundary = 3;
    const summaryObj = {
      goal: "finish the task",
      progress: `discovered ${marker}`,
      blockers: "none",
      nextSteps: "continue",
    };
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify(summaryObj) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(20, 10),
        warnings: [],
      }),
    });

    const result = await compactMessages(messages, model, evictBoundary);

    expect(result.evictedCount).toBe(evictBoundary);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toEqual(messages[3]);

    const summaryMessage = result.messages[0];
    expect(summaryMessage?.role).toBe("user");
    expect(typeof summaryMessage?.content).toBe("string");
    expect(summaryMessage?.content as string).toContain(marker);

    expect(result.summary.goal).toBeTruthy();
    expect(result.summary.progress).toBeTruthy();
    expect(result.summary.blockers).toBeTruthy();
    expect(result.summary.nextSteps).toBeTruthy();
  });

  test("stream: true uses doStream because generateText is rejected on the ChatGPT-plan host", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "do the task" },
      assistantToolCallMsg("call-1"),
      toolResultMsg("call-1", "ok"),
      { role: "user", content: "keep me, recent tail" },
    ];
    const summaryObj = {
      goal: "finish the task",
      progress: "streamed",
      blockers: "none",
      nextSteps: "continue",
    };
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("generateText is rejected on the ChatGPT-plan host");
      },
      doStream: async () => streamResult(textOnlyChunks(JSON.stringify(summaryObj))),
    });

    const result = await compactMessages(messages, model, 3, undefined, { stream: true });

    expect(result.summary.progress).toBe("streamed");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("does not send oversized tool-result bodies to the summarizer, and does not mutate the evicted messages", async () => {
    const largeBody = `UNIQUE_FILE_BODY_${"x".repeat(50_000)}`;
    const shortLiteral = "SHORT_ID_7";
    const userText = "do the task involving src/foo.ts";
    const messages: ModelMessage[] = [
      { role: "user", content: userText },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-read",
            toolName: "read_file",
            input: { path: "src/foo.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-read",
            toolName: "read_file",
            output: { type: "json", value: largeBody },
          },
        ],
      },
      assistantToolCallMsg("call-write"),
      toolResultMsg("call-write", shortLiteral),
      { role: "user", content: "keep me, recent tail" },
    ];
    const summaryObj = {
      goal: "finish the task",
      progress: `read src/foo.ts and saw ${shortLiteral}`,
      blockers: "none",
      nextSteps: "continue",
    };
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify(summaryObj) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(20, 10),
        warnings: [],
      }),
    });

    const result = await compactMessages(messages, model, 5);

    expect(model.doGenerateCalls).toHaveLength(1);
    const sent = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(sent).not.toContain(largeBody);
    expect(sent).not.toContain("UNIQUE_FILE_BODY_");
    expect(sent).toContain(shortLiteral);
    expect(sent).toContain(userText);
    expect(sent).toContain("src/foo.ts");
    expect(sent).toMatch(/"elided"\s*:\s*true/);
    expect(sent).toContain(String(Buffer.byteLength(largeBody)));
    expect(JSON.stringify(messages)).toContain(largeBody);
    expect(result.evictedCount).toBe(5);
  });
});
