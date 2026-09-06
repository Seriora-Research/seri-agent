import path from "node:path";
import { diffLines } from "./diffLines";

// Hard cap so a whole-file rewrite cannot grow the transcript without bound. The live tool
// tree already drops on turn end; these hunks are committed, so the cap is what keeps one
// write from shoving the rest of the turn off the screen. Stats stay exact; only the body
// truncates.
export const FILE_CHANGE_LINE_CAP = 12;

export type DiffLineKind = "context" | "add" | "del";

export type FileChangeLine = {
  kind: DiffLineKind;
  text: string;
};

export type FileChangeView = {
  title: string;
  added: number;
  removed: number;
  lines: FileChangeLine[];
  hidden: number;
};

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function kindOf(line: string): DiffLineKind {
  if (line.startsWith("+ ")) return "add";
  if (line.startsWith("- ")) return "del";
  return "context";
}

export function buildFileChange(title: string, before: string, after: string): FileChangeView {
  const raw = diffLines(lf(before), lf(after));
  const added = raw.filter((line) => line.startsWith("+ ")).length;
  const removed = raw.filter((line) => line.startsWith("- ")).length;
  const lines = raw.slice(0, FILE_CHANGE_LINE_CAP).map((text) => ({ kind: kindOf(text), text }));
  return { title, added, removed, lines, hidden: Math.max(0, raw.length - lines.length) };
}

export function fileChangePlainText(change: FileChangeView): string {
  const stats = `+${change.added} −${change.removed}`;
  const body = change.lines.map((line) => line.text);
  if (change.hidden > 0) body.push(`… ${change.hidden} more`);
  return [`${change.title}  ${stats}`, ...body].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isFileChangeView(value: unknown): value is FileChangeView {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Partial<FileChangeView>;
  return (
    typeof view.title === "string" &&
    typeof view.added === "number" &&
    typeof view.removed === "number" &&
    typeof view.hidden === "number" &&
    Array.isArray(view.lines)
  );
}

export function fileChangeFromTool(
  name: string,
  args: unknown,
  result: unknown,
): FileChangeView | undefined {
  const fields = asRecord(args);
  if (name === "edit") {
    const oldString = str(fields.oldString);
    const newString = str(fields.newString);
    if (oldString === undefined || newString === undefined) return undefined;
    return buildFileChange("Edit", oldString, newString);
  }
  if (name !== "write_file") return undefined;
  const filePath = str(fields.path);
  const content = str(fields.content);
  if (filePath === undefined || content === undefined) return undefined;
  const title = `Write ${path.basename(filePath)}`;
  const fromResult = asRecord(result);
  if (isFileChangeView(fromResult.change)) return fromResult.change;
  if (fromResult.previous === null || typeof fromResult.previous === "string") {
    return buildFileChange(title, fromResult.previous ?? "", content);
  }
  return undefined;
}
