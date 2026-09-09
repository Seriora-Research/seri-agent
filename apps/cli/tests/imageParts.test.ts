import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntry } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import {
  catalogAcceptsImages,
  dropUnsupportedImages,
  isImageRead,
  MAX_IMAGE_BYTES,
  sniffImage,
  toImageRead,
  toolOutputForImage,
  userContentFrom,
} from "../src/imageParts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function jpegStub(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
}

function gifStub(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
}

function webpStub(): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  return bytes;
}

function entry(accepts?: true): ModelCatalogEntry | undefined {
  if (accepts === undefined) return undefined;
  return {
    id: "vision",
    provider: "anthropic",
    displayName: "Vision",
    family: "claude",
    contextWindow: 1000,
    maxOutputTokens: 100,
    toolCall: true,
    reasoning: false,
    acceptsImageInput: true,
    pricing: undefined,
  };
}

describe("sniffImage", () => {
  test("recognizes PNG, JPEG, GIF, and WebP by magic bytes", () => {
    expect(sniffImage(PNG_1X1)?.mime).toBe("image/png");
    expect(sniffImage(jpegStub())?.mime).toBe("image/jpeg");
    expect(sniffImage(gifStub())?.mime).toBe("image/gif");
    expect(sniffImage(webpStub())?.mime).toBe("image/webp");
  });

  test("rejects a claimed MIME that disagrees with the magic", () => {
    expect(sniffImage(PNG_1X1, "image/jpeg")).toBeUndefined();
  });

  test("rejects bytes that are not an allowed image", () => {
    expect(sniffImage(new Uint8Array([0x00, 0x01, 0x02]))).toBeUndefined();
  });

  test("rejects an image over the byte cap", () => {
    const bytes = new Uint8Array(MAX_IMAGE_BYTES + 1);
    bytes.set([0x89, 0x50, 0x4e, 0x47]);
    expect(sniffImage(bytes)).toBeUndefined();
  });
});

describe("catalogAcceptsImages", () => {
  test("fail closed when the field is missing", () => {
    expect(catalogAcceptsImages(undefined)).toBe(false);
    expect(
      catalogAcceptsImages({
        id: "text",
        provider: "groq",
        displayName: "Text",
        family: "gpt-oss",
        contextWindow: 1000,
        maxOutputTokens: 100,
        toolCall: true,
        reasoning: false,
        pricing: undefined,
      }),
    ).toBe(false);
  });

  test("true only when the catalog flag is set", () => {
    expect(catalogAcceptsImages(entry(true))).toBe(true);
  });
});

describe("dropUnsupportedImages", () => {
  const filePart = imageMessage(PNG_1X1);

  test("keeps images when the catalog accepts them", () => {
    const { messages, warnings } = dropUnsupportedImages([filePart], entry(true));
    expect(warnings).toEqual([]);
    expect(messages).toEqual([filePart]);
  });

  test("strips user file parts and warns without failing", () => {
    const { messages, warnings } = dropUnsupportedImages([filePart], undefined);
    expect(warnings).toEqual(["this model does not accept images; dropped 1 attachment"]);
    expect(messages[0]).toMatchObject({ role: "user" });
    const content = (messages[0] as { content: unknown[] }).content;
    expect(content).toEqual([{ type: "text", text: "" }]);
  });

  test("does not mutate the stored messages array", () => {
    const original = [filePart];
    dropUnsupportedImages(original, undefined);
    expect(original[0]).toBe(filePart);
  });

  test("strips tool-result file parts and warns without failing", () => {
    const sniffed = sniffImage(PNG_1X1);
    if (sniffed === undefined) throw new Error("png");
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read_file",
            output: toolOutputForImage(toImageRead(sniffed)),
          },
        ],
      },
    ];
    const { messages: next, warnings } = dropUnsupportedImages(messages, undefined);
    expect(warnings).toEqual(["this model does not accept images; dropped 1 attachment"]);
    const part = (next[0] as { content: Array<{ output: { type: string; value: unknown } }> })
      .content[0];
    expect(part.output).toEqual({
      type: "content",
      value: [{ type: "text", text: "dropped image; this model does not accept image input" }],
    });
    expect((messages[0] as { content: Array<{ output: unknown }> }).content[0].output).toEqual(
      toolOutputForImage(toImageRead(sniffed)),
    );
  });
});

describe("userContentFrom and tool output", () => {
  test("text only stays a string", () => {
    expect(userContentFrom("hello", [])).toBe("hello");
  });

  test("images become file parts with base64 data", () => {
    const sniffed = sniffImage(PNG_1X1);
    if (sniffed === undefined) throw new Error("png");
    const content = userContentFrom("see", [sniffed]);
    expect(content).toEqual([
      { type: "text", text: "see" },
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: Buffer.from(PNG_1X1).toString("base64") },
      },
    ]);
  });

  test("tool output uses the file content variant", () => {
    const sniffed = sniffImage(PNG_1X1);
    if (sniffed === undefined) throw new Error("png");
    const read = toImageRead(sniffed);
    expect(isImageRead(read)).toBe(true);
    expect(toolOutputForImage(read)).toEqual({
      type: "content",
      value: [
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: read.data },
        },
      ],
    });
  });
});

function imageMessage(bytes: Uint8Array): ModelMessage {
  const sniffed = sniffImage(bytes);
  if (sniffed === undefined) throw new Error("sniff");
  return { role: "user", content: userContentFrom("", [sniffed]) };
}
