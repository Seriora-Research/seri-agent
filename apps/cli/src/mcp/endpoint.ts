import { inspect } from "node:util";
import { messageOf } from "../errors";

declare const mcpLineBrand: unique symbol;

export type McpLine = string & { readonly [mcpLineBrand]: true };

const MARKER = "REDACTED";

export class McpEndpoint {
  readonly #wire: string;

  private constructor(wire: string) {
    this.#wire = wire;
  }

  static tryParse(raw: string): McpEndpoint | undefined {
    try {
      new URL(raw);
    } catch {
      return undefined;
    }
    return new McpEndpoint(raw);
  }

  wireHref(): string {
    return this.#wire;
  }

  get protocol(): string {
    return new URL(this.#wire).protocol;
  }

  toString(): string {
    return redactMcpText(this.#wire);
  }

  toJSON(): string {
    return this.toString();
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

function partText(part: unknown): string {
  if (part instanceof McpEndpoint) return part.toString();
  if (typeof part === "string") return part;
  if (part === null || part === undefined) return "";
  return messageOf(part);
}

export function mcpLine(strings: TemplateStringsArray, ...parts: readonly unknown[]): McpLine {
  let line = strings[0] ?? "";
  for (let i = 0; i < parts.length; i++) {
    line += partText(parts[i]);
    line += strings[i + 1] ?? "";
  }
  return redactMcpText(line) as McpLine;
}

function findScheme(text: string, from: number): { index: number; length: number } | undefined {
  for (let i = from; i < text.length; i++) {
    const https = text.slice(i, i + 8);
    if (https.length === 8 && https.toLowerCase() === "https://") return { index: i, length: 8 };
    const http = text.slice(i, i + 7);
    if (http.length === 7 && http.toLowerCase() === "http://") return { index: i, length: 7 };
  }
  return undefined;
}

function isAuthorityEnd(char: string): boolean {
  return (
    char === "/" ||
    char === "?" ||
    char === "#" ||
    char === '"' ||
    char === "'" ||
    char === "<" ||
    char === ">" ||
    char === " " ||
    char === "\n" ||
    char === "\r" ||
    char === "\t"
  );
}

function stripUserinfo(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const found = findScheme(text, i);
    if (found === undefined) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, found.index);
    const authStart = found.index + found.length;
    let authEnd = authStart;
    while (authEnd < text.length) {
      const char = text[authEnd];
      if (char === undefined || isAuthorityEnd(char)) break;
      authEnd++;
    }
    const authority = text.slice(authStart, authEnd);
    const at = authority.lastIndexOf("@");
    out += text.slice(found.index, found.index + found.length);
    out += at === -1 ? authority : authority.slice(at + 1);
    i = authEnd;
  }
  return out;
}

function redactQuery(query: string): string {
  const body = query.startsWith("?") ? query.slice(1) : query;
  const prefix = query.startsWith("?") ? "?" : "";
  if (body.length === 0) return query;
  const pairs = body.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq === -1) return pair;
    if (pair.slice(eq + 1).length === 0) return pair;
    return `${pair.slice(0, eq)}=${MARKER}`;
  });
  return prefix + pairs.join("&");
}

function redactToken(token: string): string {
  const hash = token.indexOf("#");
  const queryStart = token.indexOf("?");
  if (queryStart === -1) return token;
  if (hash !== -1 && queryStart > hash) return token;
  const queryEnd = hash === -1 || hash < queryStart ? token.length : hash;
  return (
    token.slice(0, queryStart) +
    redactQuery(token.slice(queryStart, queryEnd)) +
    token.slice(queryEnd)
  );
}

function isTokenBoundary(char: string): boolean {
  return char === '"' || char === "'" || char === "<" || char === ">" || /\s/.test(char);
}

function redactMcpText(text: string): string {
  const stripped = stripUserinfo(text);
  let out = "";
  let i = 0;
  while (i < stripped.length) {
    const char = stripped[i];
    if (char !== undefined && isTokenBoundary(char)) {
      out += char;
      i++;
      continue;
    }
    let j = i;
    while (j < stripped.length) {
      const next = stripped[j];
      if (next === undefined || isTokenBoundary(next)) break;
      j++;
    }
    out += redactToken(stripped.slice(i, j));
    i = j;
  }
  return out;
}
