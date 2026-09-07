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
  classifierReason?: string;
};

export function approvalCopy(
  toolName: string,
  args: unknown,
  classifierReason?: string,
): ApprovalCopy {
  const fields = asRecord(args);
  const filePath = str(fields.path);
  const reason =
    classifierReason !== undefined && classifierReason.length > 0
      ? { classifierReason: escapeControlChars(classifierReason) }
      : {};
  if ((toolName === "write_file" || toolName === "edit") && filePath !== undefined) {
    const verb = toolName === "edit" ? "Edit" : "Write";
    const headline = `${verb} ${escapeControlChars(path.basename(filePath))}`;
    return { question: `${headline}?`, headline, detail: parentDirDisplay(filePath), ...reason };
  }
  if (toolName === "bash" || toolName === "powershell") {
    const cmd = str(fields.command) ?? "";
    const headline = `Run ${escapeControlChars(cmd)}`;
    return { question: `${headline}?`, headline, detail: "", ...reason };
  }
  const label = escapeControlChars(toolName);
  return { question: `Approve ${label}?`, headline: label, detail: "", ...reason };
}

export function optionLabels(offersAlways: boolean): readonly string[] {
  return offersAlways ? ["[y]es", "[a]lways", "[N]o"] : ["[y]es", "[N]o"];
}
