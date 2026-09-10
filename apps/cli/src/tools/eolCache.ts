const eolCache = new Map<string, "LF" | "CRLF">();
let epoch = 0;

export function getCachedEol(path: string): "LF" | "CRLF" | undefined {
  return eolCache.get(path);
}

export function eolEpoch(): number {
  return epoch;
}

export function advanceEolEpoch(): void {
  epoch += 1;
}

export function setCachedEol(path: string, eol: "LF" | "CRLF", observedAt?: number): void {
  if (observedAt !== undefined && observedAt !== epoch) return;
  eolCache.set(path, eol);
}

export function clearEolCache(): void {
  epoch += 1;
  eolCache.clear();
}
