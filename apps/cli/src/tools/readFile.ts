import { readFile as readFileBytes } from "node:fs/promises";
import { capToolResult } from "../capToolResult";
import {
  IMAGE_TOO_LARGE,
  MAX_IMAGE_BYTES,
  SCHEDULED_IMAGE_REFUSAL,
  sniffImageMime,
  toImageRead,
  type ImageRead,
} from "../imageParts";
import { setCachedEol } from "./eolCache";

export async function readFile(
  path: string,
  opts?: { images?: boolean },
): Promise<string | ImageRead> {
  const bytes = new Uint8Array(await readFileBytes(path));
  const mime = sniffImageMime(bytes);
  if (mime !== undefined) {
    if (opts?.images !== true) return SCHEDULED_IMAGE_REFUSAL;
    if (bytes.byteLength > MAX_IMAGE_BYTES) return IMAGE_TOO_LARGE;
    return toImageRead({ mime, bytes });
  }
  const raw = Buffer.from(bytes).toString("utf8");
  setCachedEol(path, raw.includes("\r\n") ? "CRLF" : "LF");
  return capToolResult(raw.replace(/\r\n/g, "\n"));
}
