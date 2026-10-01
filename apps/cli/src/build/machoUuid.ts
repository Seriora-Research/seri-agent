import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, writeSync } from "node:fs";

const MH_MAGIC_64 = 0xfeed_facf;
const LC_UUID = 0x1b;
const LC_CODE_SIGNATURE = 0x1d;
const HEADER_SIZE = 32;
const UUID_SIZE = 16;
const UUID_COMMAND_MIN = 24;
const CODE_SIGNATURE_COMMAND_MIN = 16;
const MAX_LOAD_COMMANDS_SIZE = 1024 * 1024;
const MAX_CODE_SIGNATURE_SIZE = 16 * 1024 * 1024;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade_0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade_0c02;
const CS_HASHTYPE_SHA256 = 2;
const CD_HASH_OFFSET_FIELD = 16;
const CD_CODE_LIMIT_FIELD = 32;
const CD_HASH_SIZE_FIELD = 36;
const CD_MIN_SIZE = 40;

export const BUN_COMPILE_UUID_DARWIN_ARM64 = "4c4c440c-5555-3144-a11d-99d1ccbeae57";
export const BUN_COMPILE_UUID_DARWIN_X64 = "4c4c448c-5555-3144-a18a-c2ee866ddf43";

const BUN_COMPILE_UUIDS = new Set([BUN_COMPILE_UUID_DARWIN_ARM64, BUN_COMPILE_UUID_DARWIN_X64]);

export function isBunCompileStubUuid(uuid: string): boolean {
  return BUN_COMPILE_UUIDS.has(uuid.toLowerCase());
}

export function isContentDerivedMachOUuid(uuid: string): boolean {
  const parts = uuid.toLowerCase().split("-");
  return parts.length === 5 && (parts[2]?.startsWith("5") ?? false);
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

function readU32BE(bytes: Uint8Array, offset: number): number {
  return asBuffer(bytes).readUInt32BE(offset);
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
  if (sizeofcmds > MAX_LOAD_COMMANDS_SIZE) return undefined;
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
    if (sizeofcmds > MAX_LOAD_COMMANDS_SIZE) return undefined;
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

export type Page0Repair =
  | { kind: "repaired"; slots: { offset: number; size: number }[] }
  | { kind: "absent" }
  | { kind: "unparsed" };

function findCodeSignature(bytes: Uint8Array): { dataoff: number; datasize: number } | undefined {
  if (bytes.length < HEADER_SIZE) return undefined;
  if (readU32(bytes, 0) !== MH_MAGIC_64) return undefined;
  const ncmds = readU32(bytes, 16);
  const sizeofcmds = readU32(bytes, 20);
  if (sizeofcmds > MAX_LOAD_COMMANDS_SIZE) return undefined;
  let off = HEADER_SIZE;
  const end = Math.min(bytes.length, HEADER_SIZE + sizeofcmds);
  for (let i = 0; i < ncmds && off + 8 <= end; i++) {
    const cmd = readU32(bytes, off);
    const cmdsize = readU32(bytes, off + 4);
    if (cmdsize < 8 || off + cmdsize > bytes.length) return undefined;
    if (cmd === LC_CODE_SIGNATURE) {
      if (cmdsize < CODE_SIGNATURE_COMMAND_MIN) return undefined;
      return { dataoff: readU32(bytes, off + 8), datasize: readU32(bytes, off + 12) };
    }
    off += cmdsize;
  }
  return undefined;
}

export function codeDirectoryPage0Matches(bytes: Uint8Array): boolean | undefined {
  const repair = inspectCodeDirectoryPage0(bytes, false);
  if (repair.kind !== "repaired" || repair.slots.length === 0) return undefined;
  return repair.matched === true;
}

export function repairCodeDirectoryPage0(bytes: Uint8Array): Page0Repair {
  const result = inspectCodeDirectoryPage0(bytes, true);
  if (result.kind === "repaired") return { kind: "repaired", slots: result.slots };
  return result;
}

function inspectCodeDirectoryPage0(
  bytes: Uint8Array,
  write: boolean,
): Page0Repair & { matched?: boolean } {
  const found = findCodeSignature(bytes);
  if (found === undefined) return { kind: "absent" };
  const { dataoff, datasize } = found;
  if (datasize < 12 || datasize > MAX_CODE_SIGNATURE_SIZE) return { kind: "unparsed" };
  if (dataoff + datasize > bytes.length) return { kind: "unparsed" };
  const blob = bytes.subarray(dataoff, dataoff + datasize);
  if (readU32BE(blob, 0) !== CSMAGIC_EMBEDDED_SIGNATURE) return { kind: "unparsed" };
  const count = readU32BE(blob, 8);
  const slots: { offset: number; size: number }[] = [];
  let matched = true;
  let sawCd = false;
  for (let i = 0; i < count; i++) {
    const indexOff = 12 + i * 8;
    if (indexOff + 8 > blob.length) return { kind: "unparsed" };
    const cdRel = readU32BE(blob, indexOff + 4);
    if (cdRel + CD_MIN_SIZE > blob.length) continue;
    if (readU32BE(blob, cdRel) !== CSMAGIC_CODEDIRECTORY) continue;
    const cdLen = readU32BE(blob, cdRel + 4);
    if (cdRel + cdLen > blob.length) return { kind: "unparsed" };
    const hashOffset = readU32BE(blob, cdRel + CD_HASH_OFFSET_FIELD);
    const codeLimit = readU32BE(blob, cdRel + CD_CODE_LIMIT_FIELD);
    const hashSize = blob[cdRel + CD_HASH_SIZE_FIELD] ?? 0;
    const hashType = blob[cdRel + CD_HASH_SIZE_FIELD + 1] ?? 0;
    const pageSizeLog = blob[cdRel + CD_HASH_SIZE_FIELD + 3] ?? 0;
    if (hashType !== CS_HASHTYPE_SHA256 || hashSize !== 32) continue;
    if (pageSizeLog < 8 || pageSizeLog > 16) return { kind: "unparsed" };
    if (hashOffset + hashSize > cdLen) return { kind: "unparsed" };
    const pageSize = 1 << pageSizeLog;
    const take = Math.min(pageSize, codeLimit, bytes.length);
    const digest = createHash("sha256");
    digest.update(bytes.subarray(0, take));
    if (take < pageSize) digest.update(Buffer.alloc(pageSize - take));
    const hash = digest.digest();
    const slotOff = dataoff + cdRel + hashOffset;
    const current = bytes.subarray(slotOff, slotOff + hashSize);
    if (!Buffer.from(current).equals(hash)) matched = false;
    if (write) bytes.set(hash, slotOff);
    slots.push({ offset: slotOff, size: hashSize });
    sawCd = true;
  }
  if (!sawCd) return { kind: "unparsed" };
  return { kind: "repaired", slots, matched };
}

function writeSlice(fd: number, bytes: Uint8Array, offset: number, size: number): void {
  const wrote = writeSync(fd, bytes.subarray(offset, offset + size), 0, size, offset);
  if (wrote !== size) {
    throw new Error(`wrote ${wrote} bytes at ${offset}, expected ${size}`);
  }
}

export function rewriteMachOUuidFile(path: string): StampResult {
  const bytes = new Uint8Array(readFileSync(path));
  const result = stampMachOUuid(bytes);
  if (result.kind !== "rewritten") return result;
  const found = readMachOUuid(bytes);
  if (found === undefined) return { kind: "skipped", reason: "no-uuid" };
  const repair = repairCodeDirectoryPage0(bytes);
  if (repair.kind === "unparsed") {
    throw new Error(`${path} has LC_CODE_SIGNATURE but no SHA-256 CodeDirectory to repair`);
  }
  const fd = openSync(path, "r+");
  try {
    writeSlice(fd, bytes, found.offset, UUID_SIZE);
    if (repair.kind === "repaired") {
      for (const slot of repair.slots) writeSlice(fd, bytes, slot.offset, slot.size);
    }
  } finally {
    closeSync(fd);
  }
  return result;
}
