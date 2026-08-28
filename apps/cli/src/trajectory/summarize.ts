import { DISPATCH_TOOL_NAME } from "../provider/tools";
import type { EditOutcomeStatus, Elision } from "./schema";

export const JSON_CAP_BYTES = 8192;

export type SummarizeResult = { value: unknown; elided?: Elision };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLengthOf(value: unknown): number | undefined {
  return typeof value === "string" ? Buffer.byteLength(value) : undefined;
}

export function capJson(value: unknown, maxBytes = JSON_CAP_BYTES): SummarizeResult {
  const encoded = JSON.stringify(value) ?? "null";
  const originalBytes = Buffer.byteLength(encoded);
  if (originalBytes <= maxBytes) return { value };
  return { value: null, elided: { elided: true, originalBytes } };
}

export function classifyEditError(message: string): EditOutcomeStatus {
  if (message.includes("Could not find the specified text to replace")) return "near_miss";
  if (message.includes("matched multiple times")) return "ambiguous";
  if (message.includes("disproportionately larger")) return "disproportionate";
  return "error";
}

export function summarizeArgs(name: string, args: unknown): SummarizeResult {
  if (name === "write_file" && isRecord(args)) {
    return capJson({ path: args.path, bytes: byteLengthOf(args.content) });
  }
  if (name === "read_file" && isRecord(args)) {
    return capJson({ path: args.path });
  }
  if (name === "edit" && isRecord(args)) {
    return capJson({
      oldBytes: byteLengthOf(args.oldString),
      newBytes: byteLengthOf(args.newString),
    });
  }
  if ((name === "grep" || name === "glob") && isRecord(args)) {
    return capJson({ pattern: args.pattern, path: args.path });
  }
  if ((name === "bash" || name === "powershell") && isRecord(args)) {
    return capJson({ command: args.command });
  }
  if (name === DISPATCH_TOOL_NAME && isRecord(args) && Array.isArray(args.tasks)) {
    const roles = args.tasks
      .map((task) => (isRecord(task) ? task.role : undefined))
      .filter((role): role is string => typeof role === "string");
    return capJson({ count: args.tasks.length, roles });
  }
  return capJson(args);
}

export function summarizeResult(name: string, result: unknown): SummarizeResult {
  if (name === "read_file" && typeof result === "string") {
    return { value: { bytes: Buffer.byteLength(result) } };
  }
  if (name === "write_file" && isRecord(result) && result.written === true) {
    return { value: { written: true } };
  }
  if (name === "edit" && typeof result === "string") {
    return { value: { bytes: Buffer.byteLength(result) } };
  }
  if (name === "grep" && isRecord(result)) {
    const hits =
      (Array.isArray(result.files) ? result.files.length : 0) +
      (Array.isArray(result.matches) ? result.matches.length : 0) +
      (Array.isArray(result.counts) ? result.counts.length : 0);
    return capJson({ hits, truncated: result.truncated === true });
  }
  if (name === "glob" && isRecord(result) && Array.isArray(result.files)) {
    return capJson({ hits: result.files.length, truncated: result.truncated === true });
  }
  if (
    (name === "bash" || name === "powershell") &&
    isRecord(result) &&
    typeof result.exitCode === "number"
  ) {
    return capJson({
      stdoutBytes: byteLengthOf(result.stdout) ?? 0,
      stderrBytes: byteLengthOf(result.stderr) ?? 0,
      exitCode: result.exitCode,
    });
  }
  if (name === DISPATCH_TOOL_NAME && isRecord(result) && Array.isArray(result.results)) {
    return capJson({ count: result.results.length });
  }
  return capJson(result);
}
