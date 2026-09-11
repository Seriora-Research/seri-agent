import { type FileHandle, open } from "node:fs/promises";
import { capFromBoundedWindows, capToolResult, MAX_TOOL_RESULT_CHARS } from "../capToolResult";
import {
  IMAGE_TOO_LARGE,
  type ImageRead,
  MAX_IMAGE_BYTES,
  SCHEDULED_IMAGE_REFUSAL,
  sniffImageMime,
  toImageRead,
} from "../imageParts";
import { eolEpoch, setCachedEol } from "./eolCache";

const PREFIX_BYTES = 12;
const WINDOW_BYTES = (MAX_TOOL_RESULT_CHARS / 2) * 3 + 4;
const MIDDLE_CHUNK = 64 * 1024;

type Utf16CrlfState = {
  carry: Buffer;
  pendingCr: boolean;
  units: number;
  sawCrLf: boolean;
};

export async function readFile(
  path: string,
  opts?: { images?: boolean; abortSignal?: AbortSignal },
): Promise<string | ImageRead> {
  const observedAt = eolEpoch();
  const signal = opts?.abortSignal;
  throwIfAborted(signal);

  const handle = await open(path, "r");
  try {
    throwIfAborted(signal);
    const stat = await handle.stat();
    // procfs reports size 0; FIFOs are not regular files. Slurp this handle so we never
    // consume a prefix and reopen.
    if (!stat.isFile() || stat.size === 0) {
      const bytes = new Uint8Array(await handle.readFile({ signal }));
      const mime = sniffImageMime(bytes);
      if (mime !== undefined) {
        if (opts?.images !== true) return SCHEDULED_IMAGE_REFUSAL;
        if (bytes.byteLength > MAX_IMAGE_BYTES) return IMAGE_TOO_LARGE;
        return toImageRead({ mime, bytes });
      }
      return finishText(path, bytes, observedAt);
    }

    const prefixLen = Math.min(PREFIX_BYTES, stat.size);
    const prefix = Buffer.alloc(prefixLen);
    await readAt(handle, prefix, 0, signal);
    const mime = sniffImageMime(prefix);
    if (mime !== undefined) {
      if (opts?.images !== true) return SCHEDULED_IMAGE_REFUSAL;
      if (stat.size > MAX_IMAGE_BYTES) return IMAGE_TOO_LARGE;
      if (stat.size === prefixLen) return toImageRead({ mime, bytes: prefix });
      const bytes = Buffer.alloc(stat.size);
      prefix.copy(bytes);
      await readAt(handle, bytes.subarray(prefixLen), prefixLen, signal);
      return toImageRead({ mime, bytes });
    }

    if (stat.size <= 2 * WINDOW_BYTES) {
      const bytes = Buffer.alloc(stat.size);
      prefix.copy(bytes);
      if (stat.size > prefixLen) {
        await readAt(handle, bytes.subarray(prefixLen), prefixLen, signal);
      }
      return finishText(path, bytes, observedAt);
    }

    return await readWindowedText(handle, path, stat.size, observedAt, signal);
  } finally {
    await handle.close();
  }
}

function finishText(path: string, bytes: Uint8Array, observedAt: number): string {
  const raw = Buffer.from(bytes).toString("utf8");
  setCachedEol(path, raw.includes("\r\n") ? "CRLF" : "LF", observedAt);
  return capToolResult(raw.replace(/\r\n/g, "\n"));
}

async function readWindowedText(
  handle: FileHandle,
  path: string,
  size: number,
  observedAt: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const headRaw = Buffer.alloc(WINDOW_BYTES);
  const tailRaw = Buffer.alloc(WINDOW_BYTES);
  await readAt(handle, headRaw, 0, signal);
  await readAt(handle, tailRaw, size - WINDOW_BYTES, signal);

  const headDrop = utf8TrailingIncomplete(headRaw);
  const tailSkip = utf8LeadingContinuation(tailRaw);
  const headComplete = headRaw.subarray(0, headRaw.length - headDrop);
  const tailComplete = tailRaw.subarray(tailSkip);
  const headLf = Buffer.from(headComplete).toString("utf8").replace(/\r\n/g, "\n");
  const tailLf = Buffer.from(tailComplete).toString("utf8").replace(/\r\n/g, "\n");

  const state: Utf16CrlfState = {
    carry: Buffer.alloc(0),
    pendingCr: false,
    units: 0,
    sawCrLf: false,
  };
  feedUtf16Crlf(state, headComplete, false);

  const middleStart = WINDOW_BYTES - headDrop;
  const middleEnd = size - WINDOW_BYTES + tailSkip;
  const chunk = Buffer.alloc(Math.min(MIDDLE_CHUNK, middleEnd - middleStart));
  for (let pos = middleStart; pos < middleEnd; ) {
    const n = Math.min(MIDDLE_CHUNK, middleEnd - pos);
    const slice = n === chunk.length ? chunk : chunk.subarray(0, n);
    await readAt(handle, slice, pos, signal);
    feedUtf16Crlf(state, slice, false);
    pos += n;
  }
  feedUtf16Crlf(state, tailComplete, true);

  setCachedEol(path, state.sawCrLf ? "CRLF" : "LF", observedAt);
  return capFromBoundedWindows(headLf, tailLf, state.units);
}

async function readAt(
  handle: FileHandle,
  buffer: Uint8Array,
  position: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const err = new Error("The operation was aborted") as NodeJS.ErrnoException;
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  throw err;
}

function utf8LeadNeed(byte: number): number {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 0;
}

function utf8TrailingIncomplete(bytes: Uint8Array): number {
  const n = bytes.length;
  if (n === 0) return 0;
  let i = n - 1;
  if ((bytes[i] & 0x80) === 0) return 0;
  let cont = 0;
  while (i >= 0 && (bytes[i] & 0xc0) === 0x80) {
    cont++;
    i--;
    if (cont === 3) break;
  }
  if (i < 0) return n;
  const lead = bytes[i];
  if (lead === undefined) return n;
  const need = utf8LeadNeed(lead);
  const have = n - i;
  if (need >= 2 && have < need) return have;
  return 0;
}

function utf8LeadingContinuation(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length && (bytes[i] & 0xc0) === 0x80) i++;
  return i;
}

function feedUtf16Crlf(state: Utf16CrlfState, bytes: Uint8Array, flush: boolean): void {
  const joined = state.carry.length === 0 ? bytes : Buffer.concat([state.carry, bytes]);
  const drop = flush ? 0 : utf8TrailingIncomplete(joined);
  const complete = drop === 0 ? joined : joined.subarray(0, joined.length - drop);
  state.carry = drop === 0 ? Buffer.alloc(0) : Buffer.from(joined.subarray(joined.length - drop));
  if (complete.length === 0) {
    if (flush && state.pendingCr) {
      state.units += 1;
      state.pendingCr = false;
    }
    return;
  }
  const text = Buffer.from(complete).toString("utf8");
  let rest = text;
  if (state.pendingCr) {
    state.pendingCr = false;
    if (text.charCodeAt(0) === 0x0a) {
      state.sawCrLf = true;
      state.units += 1;
      rest = text.slice(1);
    } else {
      state.units += 1;
    }
  }
  if (rest.includes("\r\n")) state.sawCrLf = true;
  const normalizedLen = rest.replace(/\r\n/g, "\n").length;
  if (!flush && rest.endsWith("\r")) {
    state.pendingCr = true;
    state.units += normalizedLen - 1;
  } else {
    state.units += normalizedLen;
  }
}
