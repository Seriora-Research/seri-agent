import { describe, expect, test } from "bun:test";
import type { JSONValue, ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  compactMessages,
  elideOversizedStrings,
  estimateTokens,
  findSafeEvictionBoundary,
  SUMMARIZER_STRING_CAP_BYTES,
} from "../../src/loop/compaction";
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

function summarizerUserText(model: MockLanguageModelV4): string {
  const user = model.doGenerateCalls[0]?.prompt.find((part) => part.role === "user");
  const content = user && "content" in user ? user.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
    .join("");
}


function buildAlternatingMessages(pairs: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "user", content: "do the task" }];
  for (let i = 0; i < pairs; i++) {
    messages.push(assistantToolCallMsg(`call-${i}`), toolResultMsg(`call-${i}`, "ok"));
  }
  return messages;
}

function keepTokensForLast(messages: ModelMessage[], count: number): number {
  if (count <= 0) return 0;
  return estimateTokens(messages.slice(-count));
}

describe("findSafeEvictionBoundary", () => {
  test("never returns a boundary pointing at a tool message, across every keep-token budget that lands on today's indexes", () => {
    const messages = buildAlternatingMessages(10);
    for (let preserve = 0; preserve <= messages.length; preserve++) {
      const boundary = findSafeEvictionBoundary(messages, keepTokensForLast(messages, preserve));
      if (boundary === null) continue;
      expect(messages[boundary]?.role).not.toBe("tool");
    }
  });

  test("walks forward past a tool message when the naive cut would split a tool-call/tool-result pair", () => {
    const messages = buildAlternatingMessages(10);
    const candidateIndex = 6;
    expect(messages[candidateIndex]?.role).toBe("tool");
    const keep = keepTokensForLast(messages, messages.length - candidateIndex);

    const boundary = findSafeEvictionBoundary(messages, keep);

    expect(boundary).toBe(candidateIndex + 1);
    expect(messages[boundary as number]?.role).toBe("assistant");
  });

  test("returns null when fewer than minEvictable messages would be evicted", () => {
    const messages = buildAlternatingMessages(10);
    expect(
      findSafeEvictionBoundary(messages, keepTokensForLast(messages, messages.length)),
    ).toBeNull();
  });

  test("a huge 19-message tail is cut while a tiny 20-message tail is kept", () => {



    const hugeBody = "H".repeat(20_000);
    const huge: ModelMessage[] = [];
    for (let i = 0; i < 9; i++) {
      huge.push(assistantToolCallMsg(`huge-${i}`), toolResultMsg(`huge-${i}`, hugeBody));
    }
    huge.push({ role: "user", content: hugeBody });
    expect(huge).toHaveLength(19);
    const hugeBoundary = findSafeEvictionBoundary(huge, 20_000);
    expect(hugeBoundary).not.toBeNull();
    expect(hugeBoundary).toBeGreaterThanOrEqual(4);
    expect(huge[hugeBoundary as number]?.role).not.toBe("tool");

    const tiny: ModelMessage[] = [];
    for (let i = 0; i < 20; i++) {
      tiny.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: i % 2 === 0 ? "ok" : [{ type: "text", text: "ok" }],
      });
    }
    expect(estimateTokens(tiny)).toBeLessThan(2_000);
    expect(findSafeEvictionBoundary(tiny, 20_000)).toBeNull();
  });
});

describe("elideOversizedStrings", () => {
  test("passes strings at or under the cap and replaces oversized ones with originalBytes", () => {
    expect(elideOversizedStrings("short")).toBe("short");
    const atCap = "a".repeat(SUMMARIZER_STRING_CAP_BYTES);
    expect(elideOversizedStrings(atCap)).toBe(atCap);
    const over = "a".repeat(SUMMARIZER_STRING_CAP_BYTES + 1);
    expect(elideOversizedStrings(over)).toEqual({
      elided: true,
      originalBytes: Buffer.byteLength(over, "utf8"),
    });
  });

  test("walks nested objects and arrays without mutating the input", () => {
    const input = {
      keep: "ok",
      nested: { body: "x".repeat(SUMMARIZER_STRING_CAP_BYTES + 1), path: "src/foo.ts" },
      list: ["y".repeat(SUMMARIZER_STRING_CAP_BYTES + 1), 7, null],
    };
    const snapshot = structuredClone(input);
    const out = elideOversizedStrings(input) as {
      keep: string;
      nested: { body: { elided: true; originalBytes: number }; path: string };
      list: unknown[];
    };
    expect(input).toEqual(snapshot);
    expect(out.keep).toBe("ok");
    expect(out.nested.path).toBe("src/foo.ts");
    expect(out.nested.body).toEqual({
      elided: true,
      originalBytes: Buffer.byteLength(input.nested.body, "utf8"),
    });
    expect(out.list[0]).toEqual({
      elided: true,
      originalBytes: Buffer.byteLength(input.list[0] as string, "utf8"),
    });
    expect(out.list[1]).toBe(7);
    expect(out.list[2]).toBeNull();
  });

  test("caps by UTF-8 bytes, not string length", () => {
    const twoByte = "é";
    expect(Buffer.byteLength(twoByte, "utf8")).toBe(2);
    const overByBytes = twoByte.repeat(SUMMARIZER_STRING_CAP_BYTES / 2 + 1);
    expect(overByBytes.length).toBeLessThanOrEqual(SUMMARIZER_STRING_CAP_BYTES);
    expect(elideOversizedStrings(overByBytes)).toEqual({
      elided: true,
      originalBytes: Buffer.byteLength(overByBytes, "utf8"),
    });
  });
});

describe("estimateTokens additivity", () => {
  test("the array estimate equals the sum of per-message estimates, including tool payloads", () => {
    const body = "x".repeat(50_000);
    const messages: ModelMessage[] = [
      { role: "user", content: "do the task" },
      assistantToolCallMsg("call-1"),
      toolResultMsg("call-1", body),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    let running = 0;
    for (const message of messages) running += estimateTokens(message);
    expect(running).toBe(estimateTokens(messages));
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
    expect(result.tokensBefore).toBe(estimateTokens(messages));
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
    const sent = summarizerUserText(model);
    expect(sent).not.toContain(largeBody);
    expect(sent).not.toContain("UNIQUE_FILE_BODY_");
    expect(sent).toContain(shortLiteral);
    expect(sent).toContain(userText);
    expect(sent).toContain("src/foo.ts");
    expect(sent).toContain('"elided":true');
    expect(sent).toContain(`"originalBytes":${Buffer.byteLength(largeBody)}`);
    expect(JSON.stringify(messages)).toContain(largeBody);
    expect(result.evictedCount).toBe(5);
  });

  test("a later compact uses an update prompt that carries the previous four fields", async () => {
    const previous = {
      goal: "ship auth",
      progress: "found the login bug",
      blockers: "missing token refresh",
      nextSteps: "patch the refresh path",
    };
    const messages: ModelMessage[] = [
      {
        role: "user",
        content:
          `[Compacted history — 8 earlier messages condensed]\n` +
          `Goal: ${previous.goal}\n` +
          `Progress: ${previous.progress}\n` +
          `Blockers: ${previous.blockers}\n` +
          `Next steps: ${previous.nextSteps}`,
      },
      assistantToolCallMsg("call-later"),
      toolResultMsg("call-later", "ok"),
      { role: "user", content: "keep me, recent tail" },
    ];
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              goal: previous.goal,
              progress: "login bug is done",
              blockers: "none",
              nextSteps: "write the test",
            }),
          },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(20, 10),
        warnings: [],
      }),
    });

    await compactMessages(messages, model, 3);

    const sent = summarizerUserText(model);
    expect(sent).toContain(previous.goal);
    expect(sent).toContain(previous.progress);
    expect(sent).toContain(previous.blockers);
    expect(sent).toContain(previous.nextSteps);
    expect(sent).toMatch(/PRESERVE/);
    expect(sent).toMatch(/promote/i);
    expect(sent).toMatch(/drop stale blockers/i);
  });

  test("appends deterministic Read/Modified paths from evicted tool-calls after parse", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "do the task" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "r1",
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
            toolCallId: "r1",
            toolName: "read_file",
            output: { type: "json", value: "old foo" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "e1",
            toolName: "edit",
            input: { path: "src/foo.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "e1",
            toolName: "edit",
            output: { type: "json", value: "new foo" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "r2",
            toolName: "read_file",
            input: { path: "src/bar.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "r2",
            toolName: "read_file",
            output: { type: "json", value: "bar" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "mcp1",
            toolName: "mcp",
            input: { path: "src/ignored.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "mcp1",
            toolName: "mcp",
            output: { type: "json", value: "nope" },
          },
        ],
      },
      { role: "user", content: "keep me, recent tail" },
    ];
    const summaryObj = {
      goal: "finish the task",
      progress: "edited foo",
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

    const result = await compactMessages(messages, model, 9);
    const sent = summarizerUserText(model);
    expect(sent).not.toContain("Read:");
    expect(sent).not.toContain("Modified:");

    const summaryText = result.messages[0]?.content as string;
    expect(summaryText).toContain("Read: src/bar.ts");
    expect(summaryText).toContain("Modified: src/foo.ts");
    expect(summaryText).not.toMatch(/Read:.*src\/foo\.ts/);
    expect(summaryText).not.toContain("src/ignored.ts");
  });
});
