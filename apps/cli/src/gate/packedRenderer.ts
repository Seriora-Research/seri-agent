import type { ModelMessage } from "ai";
import { classifyBuiltin } from "../provider/tools";

export const PACKED_RENDERER_UPLOAD = "packed-renderer-upload";

export const MIN_PACKED_PAYLOAD_CHARS = 32;

export type PackedRendererHit = {
  class: typeof PACKED_RENDERER_UPLOAD;
  host: string;
};

type PackedHost = {
  host: string;
  payload: (url: URL) => string | null;
};

function lastPathSegment(pathname: string): string {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? "";
}

function stripPakoPrefix(payload: string): string {
  return payload.replace(/^pako:/i, "");
}

const PACKED_RENDERERS: readonly PackedHost[] = [
  {
    host: "mermaid.ink",
    payload: (url) => {
      if (!url.pathname.startsWith("/img/") && !url.pathname.startsWith("/svg/")) return null;
      return lastPathSegment(url.pathname);
    },
  },
  {
    host: "mermaid.live",
    payload: (url) => {
      const blob = `${url.hash.replace(/^#/, "")}${url.search}`;
      const match = blob.match(/pako:([^&]+)/i);
      return match?.[1] ?? null;
    },
  },
  {
    host: "kroki.io",
    payload: (url) => {
      const parts = url.pathname.split("/").filter((part) => part.length > 0);
      if (parts.length < 3) return null;
      return parts.at(-1) ?? null;
    },
  },
  {
    host: "plantuml.com",
    payload: plantumlPayload,
  },
  {
    host: "www.plantuml.com",
    payload: plantumlPayload,
  },
];

function plantumlPayload(url: URL): string | null {
  if (!/\/(png|svg|txt)(\/|$)/i.test(url.pathname)) return null;
  return lastPathSegment(url.pathname);
}

function extractUrls(text: string): string[] {
  const found: string[] = [];
  const re = /https?:\/\/[^\s"'<>\\]+/gi;
  for (const match of text.matchAll(re)) {
    found.push(match[0].replace(/[),.;]+$/g, ""));
  }
  return found;
}

function payloadOf(url: URL): string | null {
  const renderer = PACKED_RENDERERS.find((entry) => entry.host === url.hostname);
  if (renderer === undefined) return null;
  const payload = renderer.payload(url);
  if (payload === null) return null;
  const body = stripPakoPrefix(payload);
  return body.length >= MIN_PACKED_PAYLOAD_CHARS ? body : null;
}

function flattenInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

// Local file writes can contain a renderer URL without sending it. bash, powershell, and an
// unknown write name (an MCP fetch) can. memory_write / skill_write are the same local shape as
// write_file — they land under the profile root — and the archivist runs them in auto.
export function packedUploadAppliesTo(toolName: string): boolean {
  if (
    toolName === "write_file" ||
    toolName === "edit" ||
    toolName === "memory_write" ||
    toolName === "skill_write"
  ) {
    return false;
  }
  return classifyBuiltin(toolName) === "write";
}

export function findPackedRendererUpload(input: unknown): PackedRendererHit | null {
  for (const raw of extractUrls(flattenInput(input))) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (payloadOf(url) === null) continue;
    return { class: PACKED_RENDERER_UPLOAD, host: url.hostname };
  }
  return null;
}

const RENDERER_TOKEN = /\b(mermaid(?:\.ink)?|kroki(?:\.io)?|plantuml)\b/i;
// Inflections listed rather than `\w*`: "rendered" is the human asking, "renderer" is not, and
// a false positive here is an upload.
const RENDER_EXPORT_TOKEN = /\b(render|export|preview|draw)(s|ed|ing|n)?\b/i;

export function humanAskedForPackedRender(text: string): boolean {
  return RENDERER_TOKEN.test(text) && RENDER_EXPORT_TOKEN.test(text);
}

export function lastUserText(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    let text = "";
    for (const part of message.content) {
      if (part.type === "text") text += part.text;
    }
    return text;
  }
  return "";
}
