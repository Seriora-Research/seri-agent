import { readFileSync } from "node:fs";
import { setCachedEol } from "./eolCache";

export function readFile(path: string): string {
  const raw = readFileSync(path, "utf8");
  // Detected from the raw content, before the CRLF->LF strip below, and cached so a write_file
  // immediately following this read doesn't re-read the file just to learn what this call already
  // saw.
  setCachedEol(path, raw.includes("\r\n") ? "CRLF" : "LF");
  return raw.replace(/\r\n/g, "\n");
}
