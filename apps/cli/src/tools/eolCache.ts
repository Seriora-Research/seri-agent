const eolCache = new Map<string, "LF" | "CRLF">();

export function getCachedEol(path: string): "LF" | "CRLF" | undefined {
  return eolCache.get(path);
}

export function setCachedEol(path: string, eol: "LF" | "CRLF"): void {
  eolCache.set(path, eol);
}

export function clearEolCache(): void {
  eolCache.clear();
}
