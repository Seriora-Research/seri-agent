import type { ModelCatalogEntry } from "@seri/model-catalog";
import type { FilePart, ModelMessage, UserContent } from "ai";

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type ImageBytes = {
  mime: ImageMime;
  bytes: Uint8Array;
};

export type ImageRead = {
  kind: "image";
  mime: ImageMime;
  data: string;
};

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const PNG = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG = [0xff, 0xd8, 0xff] as const;
const GIF = [0x47, 0x49, 0x46, 0x38] as const;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

function mimeFromMagic(bytes: Uint8Array): ImageMime | undefined {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, GIF)) return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function claimedImageMime(claimed: string | undefined): ImageMime | undefined {
  if (claimed === "image/png") return "image/png";
  if (claimed === "image/jpeg" || claimed === "image/jpg") return "image/jpeg";
  if (claimed === "image/gif") return "image/gif";
  if (claimed === "image/webp") return "image/webp";
  return undefined;
}

export function sniffImageMime(bytes: Uint8Array, claimedMime?: string): ImageMime | undefined {
  const magic = mimeFromMagic(bytes);
  if (magic === undefined) return undefined;
  const claimed = claimedImageMime(claimedMime);
  if (claimed !== undefined && claimed !== magic) return undefined;
  return magic;
}

export function sniffImage(bytes: Uint8Array, claimedMime?: string): ImageBytes | undefined {
  const mime = sniffImageMime(bytes, claimedMime);
  if (mime === undefined) return undefined;
  if (bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
  return { mime, bytes };
}

export function toImageRead(image: ImageBytes): ImageRead {
  return { kind: "image", mime: image.mime, data: Buffer.from(image.bytes).toString("base64") };
}

export function isImageRead(value: unknown): value is ImageRead {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "image" && typeof record.mime === "string" && typeof record.data === "string"
  );
}

export function imageFilePart(image: ImageBytes | ImageRead): FilePart {
  const data = "bytes" in image ? Buffer.from(image.bytes).toString("base64") : image.data;
  return {
    type: "file",
    mediaType: image.mime,
    data: { type: "data", data },
  };
}

export function userContentFrom(text: string, images: readonly ImageBytes[]): UserContent {
  if (images.length === 0) return text;
  const parts: UserContent = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const image of images) parts.push(imageFilePart(image));
  return parts;
}

export function catalogAcceptsImages(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.acceptsImageInput === true;
}

export function toolOutputForImage(result: ImageRead): {
  type: "content";
  value: Array<{ type: "file"; mediaType: string; data: { type: "data"; data: string } }>;
} {
  return {
    type: "content",
    value: [{ type: "file", mediaType: result.mime, data: { type: "data", data: result.data } }],
  };
}

function isImageFilePart(part: unknown): boolean {
  if (part === null || typeof part !== "object") return false;
  const record = part as Record<string, unknown>;
  if (record.type !== "file") return false;
  return typeof record.mediaType === "string" && record.mediaType.startsWith("image/");
}

function stripParts(parts: unknown[]): { parts: unknown[]; dropped: number } {
  const kept: unknown[] = [];
  let dropped = 0;
  for (const part of parts) {
    if (isImageFilePart(part)) dropped++;
    else kept.push(part);
  }
  return { parts: kept, dropped };
}

function stripMessage(message: ModelMessage): { message: ModelMessage; dropped: number } {
  if (message.role === "user" && Array.isArray(message.content)) {
    const stripped = stripParts(message.content);
    if (stripped.dropped === 0) return { message, dropped: 0 };
    const next = stripped.parts.length > 0 ? stripped.parts : [{ type: "text", text: "" }];
    return {
      message: { ...message, content: next as typeof message.content },
      dropped: stripped.dropped,
    };
  }
  if (message.role === "tool" && Array.isArray(message.content)) {
    let dropped = 0;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const output = part.output;
      if (output === undefined || typeof output !== "object" || output.type !== "content") {
        return part;
      }
      const stripped = stripParts(output.value);
      dropped += stripped.dropped;
      if (stripped.dropped === 0) return part;
      const value =
        stripped.parts.length > 0
          ? stripped.parts
          : [{ type: "text", text: "dropped image; this model does not accept image input" }];
      return {
        ...part,
        output: { type: "content", value } as typeof output,
      };
    });
    return { message: { ...message, content }, dropped };
  }
  return { message, dropped: 0 };
}

export function dropUnsupportedImages(
  messages: readonly ModelMessage[],
  entry: ModelCatalogEntry | undefined,
): { messages: ModelMessage[]; warnings: string[] } {
  if (catalogAcceptsImages(entry)) return { messages: [...messages], warnings: [] };
  let dropped = 0;
  const next = messages.map((message) => {
    const stripped = stripMessage(message);
    dropped += stripped.dropped;
    return stripped.message;
  });
  if (dropped === 0) return { messages: next, warnings: [] };
  const noun = dropped === 1 ? "attachment" : "attachments";
  return {
    messages: next,
    warnings: [`this model does not accept images; dropped ${dropped} ${noun}`],
  };
}

export const SCHEDULED_IMAGE_REFUSAL =
  "this file is an image; scheduled runs do not ingest screenshots";

export const IMAGE_TOO_LARGE = `this image is larger than ${MAX_IMAGE_BYTES} bytes`;
