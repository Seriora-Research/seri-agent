import path from "node:path";
import { escapeControlChars } from "../../cli/output";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// Parent of a file path, shortened the way the locked mocks paint a write: two trailing
// segments under an ellipsis, always with a trailing slash so it reads as a directory.
export function parentDirDisplay(filePath: string): string {
  const parts = filePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((p) => p !== "");
  const parent = parts.slice(0, -1);
  if (parent.length === 0) return "";
  if (parent.length <= 2) return `${parent.join("/")}/`;
  return `…/${parent.slice(-2).join("/")}/`;
}

export type ApprovalCopy = {
  question: string;
  headline: string;
  detail: string;
};

// TUI-only prose for an approval or an in-flight write. The non-interactive CLI path keeps
// approvalPromptText's JSON line so a piped `seri <task>` prompt stays one readline row.
export function approvalCopy(toolName: string, args: unknown): ApprovalCopy {
  const fields = asRecord(args);
  const filePath = str(fields.path);
  if ((toolName === "write_file" || toolName === "edit") && filePath !== undefined) {
    const verb = toolName === "edit" ? "Edit" : "Write";
    const headline = `${verb} ${escapeControlChars(path.basename(filePath))}`;
    return { question: `${headline}?`, headline, detail: parentDirDisplay(filePath) };
  }
  if (toolName === "bash" || toolName === "powershell") {
    const cmd = str(fields.command) ?? "";
    const headline = `Run ${escapeControlChars(cmd)}`;
    return { question: `${headline}?`, headline, detail: "" };
  }
  const label = escapeControlChars(toolName);
  return { question: `Approve ${label}?`, headline: label, detail: "" };
}

export function optionLabels(offersAlways: boolean): readonly string[] {
  return offersAlways ? ["[y]es", "[a]lways", "[N]o"] : ["[y]es", "[N]o"];
}
