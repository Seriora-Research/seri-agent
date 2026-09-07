import path from "node:path";
import { escapeControlChars, toolResultLine } from "../../cli/output";
import { isMcpToolName } from "../../mcp/types";
import type { DispatchResult } from "../../subagents/dispatch";
import { TODO_TOOL_NAME } from "../../todo/tool";
import type { GlobResult } from "../../tools/glob";
import type { GrepResult } from "../../tools/grep";
import type { ProcessResult } from "../../tools/spawnCollect";
import { writeFileVerification } from "../../verify/outcome";
import { TOOL_INDENT } from "../theme/spacing";
import { TREE_BRANCH, TREE_MID } from "../theme/theme";

export type ToolActivityEntry = {
  name: string;
  count: number;
  callLine: string;
  singleLine: string;
  detailLines: string[];
  anomalyLines: string[];
  open?: boolean;
};

const MCP_GROUP_KEY = "mcp";

function groupKey(name: string): string {
  return isMcpToolName(name) ? MCP_GROUP_KEY : name;
}

export const TOOL_LABELS: Record<
  string,
  { display: string; verb: string; one: string; many: string; settles?: true }
> = {
  read_file: { display: "Read", verb: "Read", one: "file", many: "files" },
  grep: { display: "Grep", verb: "Searched", one: "file", many: "files" },
  glob: { display: "Glob", verb: "Searched", one: "file", many: "files" },
  bash: { display: "Bash", verb: "Ran", one: "shell command", many: "shell commands" },
  powershell: { display: "PowerShell", verb: "Ran", one: "shell command", many: "shell commands" },
  write_file: { display: "Write", verb: "Wrote", one: "file", many: "files", settles: true },
  edit: { display: "Edit", verb: "Edited", one: "edit", many: "edits", settles: true },
  mcp: { display: "MCP", verb: "Ran MCP", one: "tool", many: "tools" },
  dispatch_subagents: {
    display: "Dispatch",
    verb: "Dispatched",
    one: "subagent",
    many: "subagents",
  },
  ask_user: { display: "Question", verb: "Asked", one: "question", many: "questions" },
  todo: {
    display: "Checklist",
    verb: "Updated",
    one: "checklist",
    many: "checklists",
  },
};

export function toolDisplayName(name: string): string {
  return TOOL_LABELS[name]?.display ?? display(name);
}

const COMMAND_CAP = 60;
const STDERR_CAP = 80;
const DETAIL_PATH_CAP = 3;
const SUB_LINE_CAP = 5;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function display(text: string): string {
  return escapeControlChars(text);
}

// Keep the original path when path.relative walks out of cwd via `..`.
export function trimPath(p: string): string {
  const relative = path.relative(process.cwd(), p);
  if (relative === "" || relative.startsWith("..")) return p;
  return relative;
}

export function primaryArg(name: string, args: unknown): string {
  const fields = asRecord(args);
  const filePath = str(fields.path);
  const pattern = str(fields.pattern);
  const command = str(fields.command);
  if (name === "bash" || name === "powershell") {
    return command === undefined ? "" : cap(display(command), COMMAND_CAP);
  }
  if (name === "grep" || name === "glob") {
    if (pattern !== undefined) return display(pattern);
    return filePath === undefined ? "" : display(trimPath(filePath));
  }
  if (name === "read_file" || name === "write_file") {
    return filePath === undefined ? "" : display(trimPath(filePath));
  }
  return "";
}

export function summarizeArgs(name: string, args: unknown): string {
  const labels = TOOL_LABELS[name];
  if (name === "edit") return labels.verb;
  if (name === "dispatch_subagents") return "Dispatched subagents";
  if (labels === undefined) return name;
  return `${labels.verb} ${primaryArg(name, args)}`.trimEnd();
}

export function toolCallLine(name: string, args: unknown): string {
  const arg = primaryArg(name, args);
  const label = toolDisplayName(name);
  return arg === "" ? `→ ${label}` : `→ ${label}(${arg})`;
}

function uniqueKeepOrder(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of paths) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function grepPaths(result: GrepResult): string[] {
  if (result.mode === "content") return uniqueKeepOrder((result.matches ?? []).map((m) => m.file));
  if (result.mode === "count") return uniqueKeepOrder((result.counts ?? []).map((c) => c.file));
  return uniqueKeepOrder(result.files ?? []);
}

function asGrepResult(result: unknown): GrepResult | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const value = result as Partial<GrepResult>;
  if (value.mode !== "files_with_matches" && value.mode !== "content" && value.mode !== "count") {
    return undefined;
  }
  return value as GrepResult;
}

function asGlobResult(result: unknown): GlobResult | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const value = result as Partial<GlobResult>;
  if (!Array.isArray(value.files) || typeof value.truncated !== "boolean") return undefined;
  return value as GlobResult;
}

export function detailLinesForResult(name: string, result: unknown): string[] {
  let paths: string[] = [];
  let truncated = false;
  if (name === "grep") {
    const grep = asGrepResult(result);
    if (grep === undefined) return [];
    paths = grepPaths(grep);
    truncated = grep.truncated;
  } else if (name === "glob") {
    const glob = asGlobResult(result);
    if (glob === undefined) return [];
    paths = glob.files;
    truncated = glob.truncated;
  } else {
    return [];
  }
  const shown = paths.slice(0, DETAIL_PATH_CAP).map((p) => display(trimPath(p)));
  const extra = paths.length - shown.length;
  if (truncated || extra > 0) {
    shown.push(extra > 0 ? `…${extra} more` : "…more");
  }
  return shown;
}

function asProcessResult(result: unknown): ProcessResult | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const value = result as Partial<ProcessResult>;
  if (typeof value.exitCode !== "number" || typeof value.timedOut !== "boolean") return undefined;
  return value as ProcessResult;
}

function stderrSnippet(stderr: string | undefined): string | undefined {
  if (stderr === undefined || stderr.length === 0) return undefined;
  const first = stderr.split(/\r?\n/, 1)[0] ?? "";
  if (first.length === 0) return undefined;
  return cap(display(first), STDERR_CAP);
}

function dispatchCounts(result: unknown): { ran: number; total: number } | undefined {
  const value = result as Partial<DispatchResult> | undefined;
  if (!Array.isArray(value?.results)) return undefined;
  return {
    ran: value.results.filter((r) => r.doneReason !== undefined).length,
    total: value.results.length,
  };
}

function writeFileAnomaly(result: unknown): string | undefined {
  const verification = writeFileVerification(result);
  if (verification === undefined) return undefined;
  if (verification.status === "failed") return `check failed: ${verification.reason}`;
  if (verification.status === "diagnostics") {
    const shown = verification.diagnostics.length;
    const count =
      shown < verification.total ? `${shown} of ${verification.total}` : `${verification.total}`;
    const noun = verification.total === 1 ? "diagnostic" : "diagnostics";
    const incomplete = verification.truncated ? ", list incomplete" : "";
    return `${count} ${noun} in ${(verification.elapsedMs / 1000).toFixed(1)}s${incomplete}`;
  }
  return undefined;
}

export function anomalyLineForResult(
  name: string,
  _args: unknown,
  result: unknown,
): string | undefined {
  if (name === "bash" || name === "powershell") {
    const proc = asProcessResult(result);
    if (proc === undefined) return undefined;
    if (!proc.timedOut && proc.exitCode === 0) return undefined;
    const head = proc.timedOut ? "timed out" : `exit ${proc.exitCode}`;
    const snippet = stderrSnippet(proc.stderr);
    return snippet === undefined ? head : `${head}: ${snippet}`;
  }
  if (name === "grep" || name === "glob") return undefined;
  if (name === "write_file") return writeFileAnomaly(result);
  if (name === "dispatch_subagents") {
    const counts = dispatchCounts(result);
    if (counts === undefined || counts.ran >= counts.total) return undefined;
    return `${counts.total - counts.ran} of ${counts.total} subagents did not finish`;
  }
  return undefined;
}

export function anomalyLineForDenial(
  reason: "blocked" | "declined" | "hook" | "containment",
): string {
  if (reason === "hook") return "blocked by hook";
  if (reason === "containment") return "blocked by containment";
  return reason;
}

const TOOL_THROW_PREFIX = /^Tool "[^"]+" threw during execution: /;
const ERROR_CTOR_PREFIX = /^Error: /;

export function anomalyLineForThrow(error: string): string {
  const text = error.replace(TOOL_THROW_PREFIX, "").replace(ERROR_CTOR_PREFIX, "");
  const first = (text.split(/\r?\n/, 1)[0] ?? "").trim();
  if (first.startsWith("ENOENT")) return "file not found";
  if (first.startsWith("EACCES") || first.startsWith("EPERM")) return "permission denied";
  if (first.startsWith("EISDIR")) return "is a directory";
  if (first.startsWith("ENOTDIR")) return "not a directory";
  if (first.length === 0) return "failed";
  return cap(display(first), STDERR_CAP);
}

function emptyEntry(name: string): ToolActivityEntry {
  return {
    name,
    count: 0,
    callLine: "",
    singleLine: "",
    detailLines: [],
    anomalyLines: [],
    open: false,
  };
}

function keepFirst(existing: string, next: string): string {
  return existing.length > 0 ? existing : next;
}

function settleCount(entry: ToolActivityEntry): number {
  return entry.open ? entry.count : entry.count + 1;
}

function appendAnomaly(existing: string[], anomaly: string | undefined): string[] {
  if (anomaly === undefined || existing.length >= 1) return existing;
  return [...existing, anomaly];
}

function mapEntry(
  entries: ToolActivityEntry[],
  name: string,
  update: (entry: ToolActivityEntry) => ToolActivityEntry,
  alwaysAppend: boolean,
): ToolActivityEntry[] {
  if (alwaysAppend) return [...entries, update(emptyEntry(name))];
  const index = entries.findIndex((entry) => entry.name === name);
  if (index < 0) return [...entries, update(emptyEntry(name))];
  const next = entries.slice();
  next[index] = update(entries[index]);
  return next;
}

function withDisplayName(line: string, name: string): string {
  const prefix = `✓ ${name} done`;
  if (!line.startsWith(prefix)) return line;
  return `✓ ${toolDisplayName(name)} done${line.slice(prefix.length)}`;
}

function settledSingleLine(name: string, args: unknown, result: unknown): string {
  if (name === "edit") {
    return withDisplayName(toolResultLine({ type: "tool-result", name, result }), name);
  }
  if (name === "write_file") {
    if (writeFileAnomaly(result) !== undefined) return `✓ ${toolDisplayName(name)} done`;
    return withDisplayName(toolResultLine({ type: "tool-result", name, result }), name);
  }
  return summarizeArgs(name, args);
}

export function recordCall(
  entries: ToolActivityEntry[],
  name: string,
  args: unknown,
): ToolActivityEntry[] {
  if (name === "dispatch_subagents" || name === TODO_TOOL_NAME) return entries;
  return mapEntry(
    entries,
    groupKey(name),
    (entry) => {
      const count = entry.count + 1;
      return {
        ...entry,
        count,
        open: true,
        callLine: keepFirst(entry.callLine, toolCallLine(name, args)),
        singleLine: keepFirst(entry.singleLine, summarizeArgs(name, args)),
        detailLines: isMcpToolName(name) ? entry.detailLines : count > 1 ? [] : entry.detailLines,
      };
    },
    false,
  );
}

function mcpDetailLines(entry: ToolActivityEntry, settledName: string, count: number): string[] {
  if (count === 1) return [];
  const priorNames = entry.detailLines.length > 0 ? entry.detailLines : [entry.singleLine];
  return [...priorNames, settledName];
}

export function recordResult(
  entries: ToolActivityEntry[],
  name: string,
  args: unknown,
  result: unknown,
): ToolActivityEntry[] {
  if (name === "dispatch_subagents" || name === TODO_TOOL_NAME) return entries;
  const anomaly = anomalyLineForResult(name, args, result);
  const details = detailLinesForResult(name, result);
  return mapEntry(
    entries,
    groupKey(name),
    (entry) => {
      const count = settleCount(entry);
      return {
        ...entry,
        count,
        open: false,
        callLine: keepFirst(entry.callLine, toolCallLine(name, args)),
        singleLine: settledSingleLine(name, args, result),
        detailLines: isMcpToolName(name)
          ? mcpDetailLines(entry, name, count)
          : count === 1
            ? details
            : [],
        anomalyLines: appendAnomaly(entry.anomalyLines, anomaly),
      };
    },
    name === "dispatch_subagents",
  );
}

export function recordThrow(
  entries: ToolActivityEntry[],
  name: string,
  args: unknown,
  error: string,
): ToolActivityEntry[] {
  return mapEntry(
    entries,
    groupKey(name),
    (entry) => ({
      ...entry,
      count: settleCount(entry),
      open: false,
      callLine: keepFirst(entry.callLine, toolCallLine(name, args)),
      singleLine: keepFirst(entry.singleLine, summarizeArgs(name, args)),
      anomalyLines: appendAnomaly(entry.anomalyLines, anomalyLineForThrow(error)),
    }),
    name === "dispatch_subagents",
  );
}

export function recordDenial(
  entries: ToolActivityEntry[],
  name: string,
  reason: "blocked" | "declined" | "hook" | "containment",
): ToolActivityEntry[] {
  const labels = TOOL_LABELS[name];
  return mapEntry(
    entries,
    groupKey(name),
    (entry) => ({
      ...entry,
      count: settleCount(entry),
      open: false,
      callLine: keepFirst(entry.callLine, `→ ${toolDisplayName(name)}`),
      singleLine: keepFirst(entry.singleLine, labels?.verb ?? name),
      anomalyLines: appendAnomaly(entry.anomalyLines, anomalyLineForDenial(reason)),
    }),
    name === "dispatch_subagents",
  );
}

function countPhrase(entry: ToolActivityEntry): string {
  const labels = TOOL_LABELS[entry.name];
  if (labels === undefined) return `${entry.name} ×${entry.count}`;
  return `${labels.verb} ${entry.count} ${entry.count === 1 ? labels.one : labels.many}`;
}

export function formatToolSummary(entries: ToolActivityEntry[]): string | undefined {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.count <= 0) continue;
    const phrase = countPhrase(entry);
    parts.push(parts.length === 0 ? phrase : `${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`);
  }
  return parts.length === 0 ? undefined : parts.join(", ");
}

function aggregateLine(entry: ToolActivityEntry): string {
  const labels = TOOL_LABELS[entry.name];
  if (entry.count === 1 && (labels === undefined || labels.settles === true)) {
    return entry.singleLine;
  }
  if (labels === undefined) return `${entry.name} ×${entry.count}`;
  return `${labels.verb} ${entry.count} ${entry.count === 1 ? labels.one : labels.many}`;
}

function cappedSubLines(lines: string[]): string[] {
  if (lines.length <= SUB_LINE_CAP) return lines;
  const kept = lines.slice(0, SUB_LINE_CAP - 1);
  return [...kept, `…and ${lines.length - kept.length} more`];
}
export function renderToolActivity(entries: ToolActivityEntry[]): string[] {
  return entries.map((entry) => {
    const subs = cappedSubLines([...entry.detailLines, ...entry.anomalyLines].map(display));
    const last = subs.length - 1;
    const marked =
      entry.name === MCP_GROUP_KEY
        ? subs.map((line, i) => `${i === last ? TREE_BRANCH : TREE_MID}${line}`)
        : subs.map((line) => `${TREE_BRANCH}${line}`);
    const body = [display(aggregateLine(entry)), ...marked];
    return [entry.callLine, ...body.map((line) => `${TOOL_INDENT}${line}`)].join("\n");
  });
}

export function liveToolActivity(entries: ToolActivityEntry[]): ToolActivityEntry[] {
  const out: ToolActivityEntry[] = [];
  for (const entry of entries) {
    if ((entry.name === "edit" || entry.name === "write_file") && entry.anomalyLines.length === 0) {
      continue;
    }
    if (entry.open && entry.count === 1) continue;
    if (entry.open && entry.count > 1) {
      out.push({ ...entry, count: entry.count - 1, open: false });
      continue;
    }
    out.push(entry);
  }
  return out;
}

export function renderLiveToolActivity(entries: ToolActivityEntry[]): string[] {
  return renderToolActivity(liveToolActivity(entries));
}
