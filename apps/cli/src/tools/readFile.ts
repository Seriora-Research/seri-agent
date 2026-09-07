import { readFileSync } from "node:fs";
import { capToolResult } from "../capToolResult";
import { setCachedEol } from "./eolCache";

export function readFile(path: string): string {
  const raw = readFileSync(path, "utf8");
  setCachedEol(path, raw.includes("\r\n") ? "CRLF" : "LF");
  return capToolResult(raw.replace(/\r\n/g, "\n"));
}
