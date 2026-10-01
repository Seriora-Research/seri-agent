import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { ARTIFACTS_DIRNAME, getArtifactsDir } from "../config/paths";
import { type ImageRead, isImageRead } from "../imageParts";

export const ARTIFACT_DATA_TYPE = "artifact";

export type ArtifactRef = {
  type: typeof ARTIFACT_DATA_TYPE;
  id: string;
  bytes: number;
  path: string;
  mime?: string;
};

const SESSION_DIR_RE = /^[A-Za-z0-9._-]+$/;
const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i;

export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === ARTIFACT_DATA_TYPE &&
    typeof record.id === "string" &&
    typeof record.bytes === "number" &&
    typeof record.path === "string"
  );
}

export function persistBinaryArtifacts(
  messages: readonly unknown[],
  configDir: string,
  sessionId: string,
): unknown[] {
  return messages.map((message) => persistValue(message, configDir, sessionId));
}

export function hydrateBinaryArtifacts(
  messages: readonly unknown[],
  configDir: string,
  sessionId: string,
): unknown[] {
  return messages.map((message) => hydrateValue(message, configDir, sessionId));
}

export function removeSessionArtifacts(configDir: string, sessionId: string): void {
  rmSync(sessionArtifactsDir(configDir, sessionId), { recursive: true, force: true });
}

function persistValue(value: unknown, configDir: string, sessionId: string): unknown {
  if (Array.isArray(value)) {
    const next = value.map((item) => persistValue(item, configDir, sessionId));
    return next.some((item, index) => item !== value[index]) ? next : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (isImageRead(value)) {
    const persisted = persistImageRead(value, configDir, sessionId);
    return persisted ?? value;
  }
  if (isFilePart(value)) {
    const persisted = persistFilePart(value, configDir, sessionId);
    return persisted ?? value;
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const replaced = persistValue(child, configDir, sessionId);
    next[key] = replaced;
    if (replaced !== child) changed = true;
  }
  return changed ? next : value;
}

function hydrateValue(value: unknown, configDir: string, sessionId: string): unknown {
  if (Array.isArray(value)) {
    const next = value.map((item) => hydrateValue(item, configDir, sessionId));
    return next.some((item, index) => item !== value[index]) ? next : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (isStoredImageRead(value)) {
    const hydrated = hydrateImageRead(value, configDir, sessionId);
    return hydrated ?? value;
  }
  if (isFilePart(value) && isArtifactRef(value.data)) {
    const hydrated = hydrateFilePart(value, configDir, sessionId);
    return hydrated ?? value;
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const replaced = hydrateValue(child, configDir, sessionId);
    next[key] = replaced;
    if (replaced !== child) changed = true;
  }
  return changed ? next : value;
}

function persistImageRead(
  image: ImageRead,
  configDir: string,
  sessionId: string,
): Record<string, unknown> | undefined {
  const bytes = decodeInline(image.data);
  if (bytes === undefined) return undefined;
  const ref = writeArtifact(bytes, configDir, sessionId, image.mime);
  if (ref === undefined) return undefined;
  return { kind: "image", mime: image.mime, artifact: ref };
}

function persistFilePart(
  part: FilePartRecord,
  configDir: string,
  sessionId: string,
): FilePartRecord | undefined {
  if (isArtifactRef(part.data)) return undefined;
  const extracted = extractFileBytes(part.data);
  if (extracted === undefined) return undefined;
  const mime =
    typeof part.mediaType === "string" && part.mediaType.length > 0
      ? part.mediaType
      : extracted.mime;
  const ref = writeArtifact(extracted.bytes, configDir, sessionId, mime);
  if (ref === undefined) return undefined;
  return { ...part, data: ref };
}

function hydrateImageRead(
  image: StoredImageRead,
  configDir: string,
  sessionId: string,
): ImageRead | undefined {
  const bytes = readArtifact(image.artifact, configDir, sessionId);
  if (bytes === undefined) return undefined;
  return {
    kind: "image",
    mime: image.mime,
    data: bytes.toString("base64"),
  };
}

function hydrateFilePart(
  part: FilePartRecord,
  configDir: string,
  sessionId: string,
): FilePartRecord | undefined {
  if (!isArtifactRef(part.data)) return undefined;
  const bytes = readArtifact(part.data, configDir, sessionId);
  if (bytes === undefined) return undefined;
  return {
    ...part,
    data: { type: "data", data: bytes.toString("base64") },
  };
}

function writeArtifact(
  bytes: Buffer,
  configDir: string,
  sessionId: string,
  mime: string | undefined,
): ArtifactRef | undefined {
  if (bytes.byteLength === 0) return undefined;
  const id = createHash("sha256").update(bytes).digest("hex");
  const filename = `${id}${extensionFor(mime)}`;
  const relativePath = join(ARTIFACTS_DIRNAME, sessionDirName(sessionId), filename);
  const absolutePath = join(configDir, relativePath);
  if (!isInsideArtifacts(configDir, absolutePath)) return undefined;
  try {
    if (!existsSync(absolutePath)) atomicWriteFile(absolutePath, bytes);
  } catch {
    return undefined;
  }
  return {
    type: ARTIFACT_DATA_TYPE,
    id,
    bytes: bytes.byteLength,
    path: toPosix(relativePath),
    ...(mime !== undefined ? { mime } : {}),
  };
}

function readArtifact(ref: ArtifactRef, configDir: string, sessionId: string): Buffer | undefined {
  const candidates = [
    join(configDir, ...ref.path.split("/")),
    join(sessionArtifactsDir(configDir, sessionId), `${ref.id}${extensionFor(ref.mime)}`),
  ];
  for (const absolutePath of candidates) {
    if (!isInsideArtifacts(configDir, absolutePath) || !existsSync(absolutePath)) continue;
    try {
      return readFileSync(absolutePath);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractFileBytes(data: unknown): { bytes: Buffer; mime?: string } | undefined {
  if (typeof data === "string") return decodePayload(data);
  if (data === null || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (record.type === "data" && typeof record.data === "string") return decodePayload(record.data);
  if (record.type === "url" && typeof record.url === "string") return decodePayload(record.url);
  return undefined;
}

function decodePayload(raw: string): { bytes: Buffer; mime?: string } | undefined {
  const dataUrl = DATA_URL_RE.exec(raw);
  if (dataUrl !== null) {
    const mime = dataUrl[1] !== undefined && dataUrl[1].length > 0 ? dataUrl[1] : undefined;
    const payload = dataUrl[3] ?? "";
    const bytes =
      dataUrl[2] !== undefined
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload));
    if (bytes.byteLength === 0) return undefined;
    return { bytes, mime };
  }
  const bytes = decodeInline(raw);
  if (bytes === undefined) return undefined;
  return { bytes };
}

function decodeInline(raw: string): Buffer | undefined {
  if (raw.length === 0) return undefined;
  const bytes = Buffer.from(raw, "base64");
  if (bytes.byteLength === 0) return undefined;
  return bytes;
}

type FilePartRecord = {
  type: "file";
  mediaType?: string;
  data: unknown;
  [key: string]: unknown;
};

function isFilePart(value: unknown): value is FilePartRecord {
  if (value === null || typeof value !== "object") return false;
  return (value as Record<string, unknown>).type === "file";
}

type StoredImageRead = {
  kind: "image";
  mime: ImageRead["mime"];
  artifact: ArtifactRef;
};

function isStoredImageRead(value: unknown): value is StoredImageRead {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "image" &&
    typeof record.mime === "string" &&
    isArtifactRef(record.artifact) &&
    record.data === undefined
  );
}

function sessionArtifactsDir(configDir: string, sessionId: string): string {
  return join(getArtifactsDir(configDir), sessionDirName(sessionId));
}

function sessionDirName(sessionId: string): string {
  return SESSION_DIR_RE.test(sessionId)
    ? sessionId
    : createHash("sha256").update(sessionId).digest("hex");
}

function extensionFor(mime: string | undefined): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  return ".bin";
}

function isInsideArtifacts(configDir: string, file: string): boolean {
  const root = resolve(getArtifactsDir(configDir));
  const target = resolve(file);
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}
