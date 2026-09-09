import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runLoop } from "../../src/loop/loop";
import { userContentFrom, sniffImage } from "../../src/imageParts";
import {
  collect,
  streamResult,
  textOnlyChunks,
  toolCallChunks,
} from "./fixtures";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const visionEntry = {
  id: "vision",
  provider: "anthropic" as const,
  displayName: "Vision",
  family: "claude",
  contextWindow: 200_000,
  maxOutputTokens: 1000,
  toolCall: true,
  reasoning: false,
  acceptsImageInput: true,
  pricing: undefined,
};

describe("runLoop image parts", () => {
  test("text-only catalog drops user images with a warning and still finishes", async () => {
    const sniffed = sniffImage(PNG_1X1);
    if (sniffed === undefined) throw new Error("png");
    const model = new MockLanguageModelV4({
      doStream: [streamResult(textOnlyChunks("ok"))],
    });
    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages: [{ role: "user", content: userContentFrom("see this", [sniffed]) }],
        permissionMode: "auto",
      }),
    );
    expect(events).toContainEqual({
      type: "error",
      error: "this model does not accept images; dropped 1 attachment",
    });
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).not.toContain(sniffed.bytes ? Buffer.from(sniffed.bytes).toString("base64") : "");
    expect(prompt).toContain("see this");
  });

  test("a vision catalog keeps the image and does not warn", async () => {
    const sniffed = sniffImage(PNG_1X1);
    if (sniffed === undefined) throw new Error("png");
    const data = Buffer.from(PNG_1X1).toString("base64");
    const model = new MockLanguageModelV4({
      doStream: [streamResult(textOnlyChunks("ok"))],
    });
    const events = await collect(
      runLoop({
        model,
        tools: {},
        messages: [{ role: "user", content: userContentFrom("see this", [sniffed]) }],
        permissionMode: "auto",
        catalog: { fetchedAt: "t", entries: [visionEntry] },
        provider: "anthropic",
        modelId: "vision",
      }),
    );
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(data);
  });

  test("read_file image result is recorded as a file content part", async () => {
    const sniffed = sniffImage(PNG_1X1);
    if (sniffed === undefined) throw new Error("png");
    const read = {
      kind: "image" as const,
      mime: "image/png" as const,
      data: Buffer.from(PNG_1X1).toString("base64"),
    };
    const tools = {
      read_file: tool({
        description: "read",
        inputSchema: z.object({ path: z.string() }),
        execute: async () => read,
      }),
    };
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "read_file", { path: "a.png" })),
        streamResult(textOnlyChunks("saw it")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools,
        messages: [{ role: "user", content: "read the screenshot" }],
        permissionMode: "auto",
        catalog: { fetchedAt: "t", entries: [visionEntry] },
        provider: "anthropic",
        modelId: "vision",
      }),
    );
    expect(events).toContainEqual({ type: "tool-result", name: "read_file", result: read });
    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(prompt).toContain('"type":"file"');
    expect(prompt).toContain(read.data);
  });
});
