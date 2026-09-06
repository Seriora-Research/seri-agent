import path from "node:path";
import { diffLines } from "./diffLines";

export const FILE_CHANGE_LINE_CAP = 12;
export const FILE_CHANGE_LINE_CHAR_CAP = 240;

export type DiffLineKind = "context" | "add" | "del";

export type FileChangeLine = {
  kind: DiffLineKind;
  text: string;
};

export type FileChangeView = {
  path?: string;
  kind: "create" | "update";
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

function capBody(text: string): string {
  return text.length > FILE_CHANGE_LINE_CHAR_CAP
    ? `${text.slice(0, FILE_CHANGE_LINE_CHAR_CAP - 1)}…`
    : text;
}

function capLines(
  lines: FileChangeLine[],
  max: number,
): { lines: FileChangeLine[]; hidden: number } {
  // diffLines emits prefix context, every del, every add, then suffix context. A prefix
  // slice of that array can be all dels. Split the budget across dels and adds, then
  // restack in that same order so leftover context cannot jump from the suffix to the top.
  const trimmed = lines.map((line) => ({ ...line, text: capBody(line.text) }));
  if (trimmed.length <= max) return { lines: trimmed, hidden: 0 };
  let prefixEnd = 0;
  while (prefixEnd < trimmed.length && trimmed[prefixEnd]?.kind === "context") prefixEnd++;
  let suffixStart = trimmed.length;
  while (suffixStart > prefixEnd && trimmed[suffixStart - 1]?.kind === "context") suffixStart--;
  const prefix = trimmed.slice(0, prefixEnd);
  const suffix = trimmed.slice(suffixStart);
  const middle = trimmed.slice(prefixEnd, suffixStart);
  const dels = middle.filter((line) => line.kind === "del");
  const adds = middle.filter((line) => line.kind === "add");
  let shownDels: FileChangeLine[];
  let shownAdds: FileChangeLine[];
  if (dels.length === 0) {
    shownDels = [];
    shownAdds = adds.slice(0, max);
  } else if (adds.length === 0) {
    shownAdds = [];
    shownDels = dels.slice(0, max);
  } else {
    const addBudget = Math.min(adds.length, Math.max(1, Math.floor(max / 2)));
    shownDels = dels.slice(0, Math.min(dels.length, max - addBudget));
    shownAdds = adds.slice(0, max - shownDels.length);
  }
  let leftover = max - shownDels.length - shownAdds.length;
  const shownPrefix = leftover > 0 ? prefix.slice(0, leftover) : [];
  leftover -= shownPrefix.length;
  const shownSuffix = leftover > 0 ? suffix.slice(0, leftover) : [];
  const shown = [...shownPrefix, ...shownDels, ...shownAdds, ...shownSuffix];
  return { lines: shown, hidden: trimmed.length - shown.length };
}

export function buildFileChange(
  title: string,
  before: string,
  after: string,
  opts?: { path?: string; maxLines?: number },
): FileChangeView {
  const raw = diffLines(lf(before), lf(after)).map((text) => ({ kind: kindOf(text), text }));
  const added = raw.filter((line) => line.kind === "add").length;
  const removed = raw.filter((line) => line.kind === "del").length;
  const kind = before.length === 0 ? "create" : "update";
  if (added === 0 && removed === 0) {
    return {
      ...(opts?.path !== undefined ? { path: opts.path } : {}),
      kind,
      title,
      added: 0,
      removed: 0,
      lines: [],
      hidden: 0,
    };
  }
  const capped = capLines(raw, opts?.maxLines ?? FILE_CHANGE_LINE_CAP);
  return {
    ...(opts?.path !== undefined ? { path: opts.path } : {}),
    kind,
    title,
    added,
    removed,
    lines: capped.lines,
    hidden: capped.hidden,
  };
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

function isDiffLineKind(value: unknown): value is DiffLineKind {
  return value === "context" || value === "add" || value === "del";
}

export function isFileChangeView(value: unknown): value is FileChangeView {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Partial<FileChangeView>;
  if (
    typeof view.title !== "string" ||
    typeof view.added !== "number" ||
    typeof view.removed !== "number" ||
    typeof view.hidden !== "number" ||
    (view.kind !== "create" && view.kind !== "update") ||
    !Array.isArray(view.lines)
  ) {
    return false;
  }
  return view.lines.every(
    (line) =>
      line !== null &&
      typeof line === "object" &&
      isDiffLineKind((line as FileChangeLine).kind) &&
      typeof (line as FileChangeLine).text === "string",
  );
}

export function fileChangeFromTool(
  name: string,
  args: unknown,
  result: unknown,
  opts?: { maxLines?: number },
): FileChangeView | undefined {
  const fields = asRecord(args);
  if (name === "edit") {
    const content = str(fields.content);
    const after = str(result);
    if (content !== undefined && after !== undefined) {
      return buildFileChange("Edit", content, after, opts);
    }
    const oldString = str(fields.oldString);
    const newString = str(fields.newString);
    if (oldString === undefined || newString === undefined) return undefined;
    return buildFileChange("Edit", oldString, newString, opts);
  }
  if (name !== "write_file") return undefined;
  const fromResult = asRecord(result);
  if (isFileChangeView(fromResult.change)) return fromResult.change;
  const filePath = str(fields.path);
  const content = str(fields.content);
  if (filePath === undefined || content === undefined) return undefined;
  const title = `Write ${path.basename(filePath)}`;
  if (fromResult.previous === null || typeof fromResult.previous === "string") {
    return buildFileChange(title, fromResult.previous ?? "", content, {
      path: filePath,
      ...opts,
    });
  }
  return undefined;
}
