import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, writeSync } from "node:fs";

const MH_MAGIC_64 = 0xfeed_facf;
const LC_UUID = 0x1b;
const HEADER_SIZE = 32;
const UUID_SIZE = 16;
const UUID_COMMAND_MIN = 24;

export const BUN_COMPILE_UUID_DARWIN_ARM64 = "4c4c440c-5555-3144-a11d-99d1ccbeae57";
export const BUN_COMPILE_UUID_DARWIN_X64 = "4c4c448c-5555-3144-a18a-c2ee866ddf43";

const BUN_COMPILE_UUIDS = new Set([BUN_COMPILE_UUID_DARWIN_ARM64, BUN_COMPILE_UUID_DARWIN_X64]);

export function isBunCompileStubUuid(uuid: string): boolean {
  return BUN_COMPILE_UUIDS.has(uuid.toLowerCase());
}

export function isDarwinCompileTarget(
  target: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (target !== undefined && target.length > 0) return target.includes("darwin");
  return platform === "darwin";
}

export type MachOUuid = {
  offset: number;
  uuid: string;
};

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return asBuffer(bytes).readUInt32LE(offset);
}

function formatUuid(bytes: Uint8Array): string {
  const hex = asBuffer(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function readMachOUuid(bytes: Uint8Array): MachOUuid | undefined {
  if (bytes.length < HEADER_SIZE) return undefined;
  if (readU32(bytes, 0) !== MH_MAGIC_64) return undefined;
  const ncmds = readU32(bytes, 16);
  const sizeofcmds = readU32(bytes, 20);
  let off = HEADER_SIZE;
  const end = Math.min(bytes.length, HEADER_SIZE + sizeofcmds);
  for (let i = 0; i < ncmds && off + 8 <= end; i++) {
    const cmd = readU32(bytes, off);
    const cmdsize = readU32(bytes, off + 4);
    if (cmdsize < 8 || off + cmdsize > bytes.length) return undefined;
    if (cmd === LC_UUID) {
      if (cmdsize < UUID_COMMAND_MIN) return undefined;
      return {
        offset: off + 8,
        uuid: formatUuid(bytes.subarray(off + 8, off + 8 + UUID_SIZE)),
      };
    }
    off += cmdsize;
  }
  return undefined;
}

export function readMachOUuidFromFile(path: string): MachOUuid | undefined {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    if (readSync(fd, header, 0, HEADER_SIZE, 0) < HEADER_SIZE) return undefined;
    const sizeofcmds = readU32(header, 20);
    const total = HEADER_SIZE + sizeofcmds;
    const buf = Buffer.alloc(total);
    header.copy(buf);
    if (sizeofcmds > 0) {
      const got = readSync(fd, buf, HEADER_SIZE, sizeofcmds, HEADER_SIZE);
      if (got < sizeofcmds) return undefined;
    }
    return readMachOUuid(buf);
  } finally {
    closeSync(fd);
  }
}

function contentDerivedUuid(bytes: Uint8Array, offset: number): Uint8Array {
  const digest = createHash("sha256")
    .update(bytes.subarray(0, offset))
    .update(Buffer.alloc(UUID_SIZE))
    .update(bytes.subarray(offset + UUID_SIZE))
    .digest();
  const uuid = Uint8Array.from(digest.subarray(0, UUID_SIZE));
  const version = uuid[6] ?? 0;
  const variant = uuid[8] ?? 0;
  uuid[6] = (version & 0x0f) | 0x50;
  uuid[8] = (variant & 0x3f) | 0x80;
  return uuid;
}

export type StampResult =
  | { kind: "rewritten"; before: string; after: string }
  | { kind: "unchanged"; uuid: string }
  | { kind: "skipped"; reason: "not-mach-o" | "no-uuid" };

export function stampMachOUuid(bytes: Uint8Array): StampResult {
  const found = readMachOUuid(bytes);
  if (found === undefined) {
    if (bytes.length < HEADER_SIZE || readU32(bytes, 0) !== MH_MAGIC_64) {
      return { kind: "skipped", reason: "not-mach-o" };
    }
    return { kind: "skipped", reason: "no-uuid" };
  }
  const next = contentDerivedUuid(bytes, found.offset);
  const after = formatUuid(next);
  if (after === found.uuid) return { kind: "unchanged", uuid: after };
  bytes.set(next, found.offset);
  return { kind: "rewritten", before: found.uuid, after };
}

export function rewriteMachOUuidFile(path: string): StampResult {
  const bytes = new Uint8Array(readFileSync(path));
  const result = stampMachOUuid(bytes);
  if (result.kind !== "rewritten") return result;
  const found = readMachOUuid(bytes);
  if (found === undefined) return { kind: "skipped", reason: "no-uuid" };
  const fd = openSync(path, "r+");
  try {
    const wrote = writeSync(
      fd,
      bytes.subarray(found.offset, found.offset + UUID_SIZE),
      0,
      UUID_SIZE,
      found.offset,
    );
    if (wrote !== UUID_SIZE) {
      throw new Error(`wrote ${wrote} UUID bytes, expected ${UUID_SIZE}`);
    }
  } finally {
    closeSync(fd);
  }
  return result;
}
