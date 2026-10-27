import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  estimateTokens,
  type MessageTokenCap,
  maxMessageTokens,
  trimOversizedMessages,
} from "../../src/loop/compaction";

function tokenCap(usableInput: number): MessageTokenCap {
  return maxMessageTokens(usableInput);
}

const CAP = tokenCap(128);

function userText(content: string): ModelMessage {
  return { role: "user", content, providerOptions: { groq: { keep: true } } };
}

function cap(tokens: number): MessageTokenCap {
  return tokens as MessageTokenCap;
}

describe("maxMessageTokens", () => {
  test("is half the usable window and stays strictly inside it", () => {
    expect(maxMessageTokens(131_072)).toBe(cap(65_536));
    expect(maxMessageTokens(20_000)).toBe(cap(10_000));
    expect(maxMessageTokens(8192)).toBe(cap(4096));
    expect(maxMessageTokens(2_000)).toBe(cap(1_000));
    expect(maxMessageTokens(1)).toBe(cap(1));
    expect(maxMessageTokens(Number.NaN)).toBe(cap(1));
    for (const usable of [2, 100, 8192, 8193, 20_000, 131_072]) {
      const cap = maxMessageTokens(usable);
      expect(cap).toBeGreaterThanOrEqual(1);
      if (usable > 1) expect(cap).toBeLessThan(usable);
    }
  });
});

describe("trimOversizedMessages", () => {
  test("truncates a string user message and leaves a smaller one untouched", () => {
    const huge = userText("x".repeat(4_000));
    const small = userText("short");
    const result = trimOversizedMessages([huge, small], CAP);

    expect(result.trims).toEqual([
      {
        index: 0,
        tokensBefore: estimateTokens(huge),
        omittedChars: expect.any(Number),
      },
    ]);
    expect(result.trims[0]?.omittedChars).toBeGreaterThan(0);
    expect(result.messages[1]).toBe(small);
    const trimmed = result.messages[0];
    expect(trimmed?.role).toBe("user");
    expect(trimmed && "providerOptions" in trimmed ? trimmed.providerOptions : undefined).toEqual({
      groq: { keep: true },
    });
    expect(typeof trimmed?.content).toBe("string");
    expect(trimmed?.content).toContain("characters omitted");
    expect(estimateTokens(trimmed!)).toBeLessThanOrEqual(CAP);
  });

  test("caps text parts and keeps a short sibling part", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "h".repeat(4_000), providerOptions: { groq: { keep: true } } },
          { type: "text", text: "tail" },
        ],
      },
    ];
    const result = trimOversizedMessages(messages, CAP);
    const content = result.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    expect(content[1]).toEqual({ type: "text", text: "tail" });
    const head = content[0];
    expect(head && typeof head === "object" && "text" in head ? head.text : "").toContain(
      "characters omitted",
    );
    expect(
      head && typeof head === "object" && "providerOptions" in head
        ? head.providerOptions
        : undefined,
    ).toEqual({
      groq: { keep: true },
    });
    expect(estimateTokens(result.messages[0]!)).toBeLessThanOrEqual(CAP);
  });

  test("is a no-op under the cap and a second pass reports no trims", () => {
    const messages: ModelMessage[] = [userText("short")];
    const once = trimOversizedMessages(messages, CAP);
    expect(once.trims).toEqual([]);
    expect(once.messages).toBe(messages);

    const huge = trimOversizedMessages([userText("z".repeat(4_000))], CAP);
    const twice = trimOversizedMessages(huge.messages, CAP);
    expect(twice.trims).toEqual([]);
    expect(twice.messages).toBe(huge.messages);
    expect(twice.messages[0]).toBe(huge.messages[0]);
  });

  test("does not split a surrogate pair and stays inside the cap", () => {
    const text = "\u{1F600}".repeat(500);
    const result = trimOversizedMessages([{ role: "user", content: text }], CAP);
    const content = result.messages[0]?.content;
    expect(typeof content).toBe("string");
    if (typeof content !== "string") return;
    expect(content).toContain("characters omitted");
    expect(content).not.toContain("\uFFFD");
    expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
    expect(estimateTokens(result.messages[0]!)).toBeLessThanOrEqual(CAP);
  });

  test("does not mutate the input array or its messages", () => {
    const messages: ModelMessage[] = [userText("m".repeat(4_000))];
    const before = messages[0];
    const content = before?.content;
    trimOversizedMessages(messages, CAP);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(before);
    expect(messages[0]?.content).toBe(content);
  });

  test("caps a file payload without dropping the message", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: "A".repeat(8_000) },
          },
        ],
      },
    ];
    const result = trimOversizedMessages(messages, CAP);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(JSON.stringify(result.messages[0]?.content)).toContain("characters omitted");
    expect(JSON.stringify(result.messages[0]?.content)).toContain("image/png");
    expect(estimateTokens(result.messages[0]!)).toBeLessThanOrEqual(CAP);
  });

  test("replaces an image part whose payload alone exceeds the cap", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "image", image: "y".repeat(5_000), mediaType: "image/png" }],
      },
    ];
    const result = trimOversizedMessages(messages, CAP);
    const encoded = JSON.stringify(result.messages[0]?.content);
    expect(encoded).toContain("image/png");
    expect(encoded).not.toContain("y".repeat(80));
    expect(estimateTokens(result.messages[0]!)).toBeLessThanOrEqual(CAP);
    expect(trimOversizedMessages(result.messages, CAP).trims).toEqual([]);
  });

  test("keeps a tool call paired with its result", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "write_file",
            input: { path: "p".repeat(8_000) },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "write_file",
            output: { type: "text", value: "v".repeat(8_000) },
          },
        ],
      },
    ];
    const result = trimOversizedMessages(messages, CAP);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("tool");
    const call = result.messages[0]?.content;
    const tool = result.messages[1]?.content;
    expect(
      Array.isArray(call) && call[0] && "toolCallId" in call[0] ? call[0].toolCallId : "",
    ).toBe("call-1");
    expect(
      Array.isArray(tool) && tool[0] && "toolCallId" in tool[0] ? tool[0].toolCallId : "",
    ).toBe("call-1");
    expect(estimateTokens(result.messages[0]!)).toBeLessThanOrEqual(CAP);
    expect(estimateTokens(result.messages[1]!)).toBeLessThanOrEqual(CAP);
    expect(JSON.stringify(call)).toContain("characters omitted");
    expect(JSON.stringify(tool)).toContain("characters omitted");
  });
});
