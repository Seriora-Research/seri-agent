import { describe, expect, test } from "bun:test";
import type { JSONValue, ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { compactMessages, findSafeEvictionBoundary } from "../../src/loop/compaction";

function usage(inputTotal: number, outputTotal: number) {
  return {
    inputTokens: { total: inputTotal, noCache: inputTotal, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
  };
}

function assistantToolCallMsg(id: string): ModelMessage {
  return { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "write_file", input: {} }] };
}

function toolResultMsg(id: string, value: JSONValue): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "write_file", output: { type: "json", value } }],
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
});
