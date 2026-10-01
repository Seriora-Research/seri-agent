import { isArtifactRef } from "./artifacts";

export type SecretKind =
  | "github-pat"
  | "github-token"
  | "aws-access-key"
  | "anthropic-key"
  | "sk-key"
  | "groq-key"
  | "xai-key"
  | "google-api-key"
  | "slack-token"
  | "gitlab-pat"
  | "jwt"
  | "private-key"
  | "bearer"
  | "url-credential"
  | "env-secret"
  | "withheld";

export type SecretTally = { readonly [K in SecretKind]?: number };

type SecretShape = {
  readonly kind: Exclude<SecretKind, "withheld">;
  readonly pattern: RegExp;
  readonly tail: boolean;
  readonly accept?: (value: string) => boolean;
};

const MARKER_RE = /\[redacted:[a-z0-9-]+(?::[A-Za-z0-9+/=_-]{1,8})?\]/g;
const TAIL_ALPHABET = /[A-Za-z0-9]/g;
const TAIL_LENGTH = 4;
const WITHHELD_MARKER = "[redacted:withheld]";

const SECRET_SHAPES: readonly SecretShape[] = [
  {
    kind: "github-pat",
    pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/dg,
    tail: true,
  },
  { kind: "github-token", pattern: /\bgh[ousr]_[A-Za-z0-9]{20,}/dg, tail: true },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/dg, tail: true },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/dg, tail: true },
  {
    kind: "sk-key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/dg,
    tail: true,
    accept: hasLetterAndDigit,
  },
  { kind: "groq-key", pattern: /\bgsk_[A-Za-z0-9]{20,}/dg, tail: true },
  { kind: "xai-key", pattern: /\bxai-[A-Za-z0-9]{20,}/dg, tail: true },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/dg, tail: true },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}/dg, tail: true },
  { kind: "gitlab-pat", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/dg, tail: true },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg,
    tail: false,
  },
  {
    kind: "private-key",
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/dg,
    tail: false,
  },
  { kind: "bearer", pattern: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{20,}=*)/dg, tail: false },
  {
    kind: "url-credential",
    pattern: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]+:([^\s/@]+)@/dg,
    tail: false,
    accept: isLiteralValue,
  },
  {
    kind: "env-secret",
    pattern:
      /(?:^|(?<=\s))[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY)[A-Za-z0-9_]*=(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"']\S*))/dgm,
    tail: false,
    accept: isLiteralValue,
  },
];

function hasLetterAndDigit(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

function isLiteralValue(value: string): boolean {
  if (value.length < 8) return false;
  if (!hasLetterAndDigit(value)) return false;
  if (value.startsWith("$") || value.startsWith("%") || value.startsWith("<")) return false;
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith(".")) return false;
  if (value.includes("://")) return false;
  return true;
}

function markerSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(MARKER_RE)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }
  return spans;
}

function overlaps(
  start: number,
  end: number,
  spans: readonly { start: number; end: number }[],
): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

function tailOf(value: string): string {
  const chars = value.match(TAIL_ALPHABET) ?? [];
  if (chars.length < TAIL_LENGTH) return chars.join("");
  return chars.slice(-TAIL_LENGTH).join("");
}

function markerFor(kind: Exclude<SecretKind, "withheld">, secret: string, tailed: boolean): string {
  if (!tailed) return `[redacted:${kind}]`;
  const tail = tailOf(secret);
  return tail.length === 0 ? `[redacted:${kind}]` : `[redacted:${kind}:${tail}]`;
}

type Hit = {
  start: number;
  end: number;
  kind: Exclude<SecretKind, "withheld">;
  secret: string;
  tailed: boolean;
  rank: number;
};

function collectHits(
  text: string,
  protectedSpans: readonly { start: number; end: number }[],
): Hit[] {
  const hits: Hit[] = [];
  for (const [rank, shape] of SECRET_SHAPES.entries()) {
    for (const match of text.matchAll(shape.pattern)) {
      const indices = match.indices;
      let start = match.index ?? 0;
      let end = start + match[0].length;
      let secret = match[0];
      if (indices) {
        const captured = indices.slice(1).find((pair) => pair !== undefined);
        if (captured !== undefined) {
          start = captured[0];
          end = captured[1];
          secret = text.slice(start, end);
        }
      }
      if (end <= start) continue;
      if (shape.accept !== undefined && !shape.accept(secret)) continue;
      if (overlaps(start, end, protectedSpans)) continue;
      hits.push({ start, end, kind: shape.kind, secret, tailed: shape.tail, rank });
    }
  }
  return hits;
}

function mergeHits(hits: Hit[]): Hit[] {
  const ordered = [...hits].sort((a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end);
  const kept: Hit[] = [];
  for (const hit of ordered) {
    if (kept.some((chosen) => hit.start < chosen.end && hit.end > chosen.start)) continue;
    kept.push(hit);
  }
  return kept;
}

export function redactText(text: string): { text: string; found: SecretTally } {
  const found: Record<string, number> = {};
  let current = text;
  for (let pass = 0; pass < 8; pass++) {
    const protectedSpans = markerSpans(current);
    const hits = mergeHits(collectHits(current, protectedSpans));
    if (hits.length === 0) break;
    let rebuilt = "";
    let cursor = 0;
    for (const hit of hits) {
      rebuilt += current.slice(cursor, hit.start);
      rebuilt += markerFor(hit.kind, hit.secret, hit.tailed);
      found[hit.kind] = (found[hit.kind] ?? 0) + 1;
      cursor = hit.end;
    }
    rebuilt += current.slice(cursor);
    if (rebuilt === current) break;
    current = rebuilt;
  }
  return { text: current, found };
}

export function mergeTally(...parts: readonly SecretTally[]): SecretTally {
  const found: Record<string, number> = {};
  for (const part of parts) {
    for (const [kind, count] of Object.entries(part)) {
      if (count === undefined || count === 0) continue;
      found[kind] = (found[kind] ?? 0) + count;
    }
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImagePart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const media = value.mediaType ?? value.mime;
  return typeof media === "string" && media.startsWith("image/");
}

function mapLeaves(
  value: unknown,
  onString: (text: string) => { value: string; found: SecretTally },
): { value: unknown; found: SecretTally } {
  if (typeof value === "string") return onString(value);
  if (Array.isArray(value)) {
    let found: SecretTally = {};
    const next = value.map((entry) => {
      const mapped = mapLeaves(entry, onString);
      found = mergeTally(found, mapped.found);
      return mapped.value;
    });
    return { value: next, found };
  }
  if (isImagePart(value) || isArtifactRef(value)) return { value, found: {} };
  if (isRecord(value)) {
    let found: SecretTally = {};
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const mapped = mapLeaves(entry, onString);
      found = mergeTally(found, mapped.found);
      next[key] = mapped.value;
    }
    return { value: next, found };
  }
  return { value, found: {} };
}

function patternReplace(text: string): { value: string; found: SecretTally } {
  const redacted = redactText(text);
  return { value: redacted.text, found: redacted.found };
}

function withholdString(text: string): { value: string; found: SecretTally } {
  if (text === WITHHELD_MARKER) return { value: text, found: {} };
  return { value: WITHHELD_MARKER, found: { withheld: 1 } };
}

export function withheldToolCallIds(messages: readonly unknown[]): Set<string> {
  const calls = new Set<string>();
  const ran = new Set<string>();
  const denied = new Set<string>();
  let unmatchedResult = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (!isRecord(part) || part.type !== "tool-call") continue;
        if (typeof part.toolCallId === "string") calls.add(part.toolCallId);
      }
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (!isRecord(part)) continue;
        if (part.type !== "tool-result" && part.type !== undefined) continue;
        if (typeof part.toolCallId !== "string") {
          unmatchedResult = true;
          continue;
        }
        const output = part.output;
        const isDenied = isRecord(output) && output.type === "execution-denied";
        if (isDenied) denied.add(part.toolCallId);
        else ran.add(part.toolCallId);
      }
    }
  }
  const withheld = new Set<string>();
  for (const id of calls) {
    if (denied.has(id) || (!ran.has(id) && !unmatchedResult)) withheld.add(id);
  }
  return withheld;
}

function redactToolCallInput(
  input: unknown,
  withheld: boolean,
): { value: unknown; found: SecretTally } {
  return mapLeaves(input, withheld ? withholdString : patternReplace);
}

function redactMessage(
  message: unknown,
  withheld: ReadonlySet<string>,
): { value: unknown; found: SecretTally } {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return { value: message, found: {} };
  }
  if (message.role === "assistant") {
    let found: SecretTally = {};
    const content = message.content.map((part) => {
      if (!isRecord(part) || part.type !== "tool-call") return part;
      const id = typeof part.toolCallId === "string" ? part.toolCallId : undefined;
      const key = "input" in part ? "input" : "args" in part ? "args" : undefined;
      if (key === undefined) return part;
      const mapped = redactToolCallInput(part[key], id !== undefined && withheld.has(id));
      found = mergeTally(found, mapped.found);
      return { ...part, [key]: mapped.value };
    });
    return { value: { ...message, content }, found };
  }
  if (message.role === "tool") {
    let found: SecretTally = {};
    const content = message.content.map((part) => {
      if (!isRecord(part)) return part;
      const next = { ...part };
      for (const key of ["output", "result"] as const) {
        if (!(key in part)) continue;
        const mapped = mapLeaves(part[key], patternReplace);
        found = mergeTally(found, mapped.found);
        next[key] = mapped.value;
      }
      return next;
    });
    return { value: { ...message, content }, found };
  }
  return { value: message, found: {} };
}

function stringify(value: unknown, label: string): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`${label} must be JSON-serializable`);
  return json;
}

export function encodeMessageJson(
  message: unknown,
  withheld: ReadonlySet<string>,
): { json: string; found: SecretTally } {
  const redacted = redactMessage(message, withheld);
  return { json: stringify(redacted.value, "Session messages"), found: redacted.found };
}

export function encodeSessionMessages(messages: readonly unknown[]): {
  json: string[];
  found: SecretTally;
} {
  const withheld = withheldToolCallIds(messages);
  let found: SecretTally = {};
  const json = messages.map((message) => {
    const encoded = encodeMessageJson(message, withheld);
    found = mergeTally(found, encoded.found);
    return encoded.json;
  });
  return { json, found };
}

export function encodeRecapJson(recap: unknown): { json: string; found: SecretTally } {
  const redacted = mapLeaves(recap, patternReplace);
  return { json: stringify(redacted.value, "Session compact recap"), found: redacted.found };
}

function redactApprovalArgs(value: unknown): { value: unknown; found: SecretTally } {
  if (!isRecord(value)) return mapLeaves(value, patternReplace);
  const event = isRecord(value.event) ? value.event : value;
  if (event.type !== "approval-request") return mapLeaves(value, patternReplace);
  const mapped = redactToolCallInput(event.args, true);
  if (isRecord(value.event)) {
    return {
      value: { ...value, event: { ...value.event, args: mapped.value } },
      found: mapped.found,
    };
  }
  return { value: { ...value, args: mapped.value }, found: mapped.found };
}

export function encodeBlobJson(value: unknown): { json: string; found: SecretTally } {
  const redacted = redactApprovalArgs(value);
  return { json: stringify(redacted.value, "Durable record"), found: redacted.found };
}

export function formatSecretTally(found: SecretTally): string {
  const parts = Object.entries(found)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([kind, count]) => `${kind} ${count}`);
  return parts.join(", ");
}
