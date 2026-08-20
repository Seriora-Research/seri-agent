// Shared by readFile.ts and writeFile.ts so a write immediately following a read of the same path
// doesn't re-read the file from disk solely to detect its line-ending style — readFile.ts already
// saw the raw content once, and writeFile.ts already knows the EOL it just wrote. A plain module-
// level Map, not a class: both callers only ever get/set by path, no other state to carry.
const eolCache = new Map<string, "LF" | "CRLF">();

export function getCachedEol(path: string): "LF" | "CRLF" | undefined {
  return eolCache.get(path);
}

export function setCachedEol(path: string, eol: "LF" | "CRLF"): void {
  eolCache.set(path, eol);
}
