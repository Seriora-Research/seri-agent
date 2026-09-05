import { basename } from "node:path";

export function looksLikeSeriBinary(execPath: string): boolean {
  const base = basename(execPath).toLowerCase();
  return base === "seri" || base === "seri.exe" || base.startsWith("seri-");
}
