// Pure TUI tool-call/result accumulation — no Ink/React import. Live rendering reads
// `pendingTool` (app.tsx); this module only tracks per-tool-name stats until turn-end, when
// `renderToolActivity` turns them into muted transcript lines. Aggregation is by exact tool
// name. `dispatch_subagents` is never aggregated: each call stays its own entry so the
// per-call task/token line from `toolResultLine` is kept.
import path from "node:path";
import { toolResultLine } from "../../cli/output";
import type { DispatchResult } from "../../subagents/dispatch";
import type { GlobResult } from "../../tools/glob";
import type { GrepResult } from "../../tools/grep";
import type { ProcessResult } from "../../tools/spawnCollect";
import { writeFileVerification } from "../../verify/outcome";
import { TREE_BRANCH } from "../theme/theme";

export type ToolActivityEntry = {
  name: string;
  count: number;
  singleLine: string;
  detailLines: string[];
  anomalyLines: string[];
};

export const TOOL_LABELS: Record<string, { verb: string; noun: string }> = {
  read_file: { verb: "Read", noun: "files" },
  grep: { verb: "Searched", noun: "searches" },
  glob: { verb: "Searched", noun: "searches" },
  bash: { verb: "Ran", noun: "shell commands" },
  powershell: { verb: "Ran", noun: "shell commands" },
  write_file: { verb: "Wrote", noun: "files" },
  edit: { verb: "Edited", noun: "edits" },
};

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

// cwd-relative when the path is inside the process cwd; otherwise the original string
// (a relative() that walks out via `..` is not a useful display path).
export function trimPath(p: string): string {
  const relative = path.relative(process.cwd(), p);
  if (relative === "" || relative.startsWith("..")) return p;
  return relative;
}

export function summarizeArgs(name: string, args: unknown): string {
  const fields = asRecord(args);
  const filePath = str(fields.path);
  const pattern = str(fields.pattern);
  const command = str(fields.command);
  const labels = TOOL_LABELS[name];
  if (name === "bash" || name === "powershell") {
    return `${labels.verb} ${command === undefined ? "" : cap(command, COMMAND_CAP)}`.trimEnd();
  }
  if (name === "grep" || name === "glob") {
    return `${labels.verb} ${pattern ?? (filePath === undefined ? "" : trimPath(filePath))}`.trimEnd();
  }
  if (name === "read_file" || name === "write_file") {
    return `${labels.verb} ${filePath === undefined ? "" : trimPath(filePath)}`.trimEnd();
  }
  if (name === "edit") return labels.verb;
  if (name === "dispatch_subagents") return "Dispatched subagents";
  return name;
}

function grepPaths(result: GrepResult): string[] {
  if (result.mode === "content") return (result.matches ?? []).map((m) => m.file);
  if (result.mode === "count") return (result.counts ?? []).map((c) => c.file);
  return result.files ?? [];
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

// grep/glob only — up to 3 trimmed match paths, plus an overflow line when the result is
// truncated or there are more paths than the cap. Every other tool returns []. A successful
// search still gets these lines (the one exception to "success adds no line").
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
  const shown = paths.slice(0, DETAIL_PATH_CAP).map(trimPath);
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
  return cap(first, STDERR_CAP);
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
  // truncated on grep/glob is folded into detailLinesForResult's overflow line, not an anomaly.
  if (name === "grep" || name === "glob") return undefined;
  if (name === "write_file") return writeFileAnomaly(result);
  if (name === "dispatch_subagents") {
    const counts = dispatchCounts(result);
    if (counts === undefined || counts.ran >= counts.total) return undefined;
    return `${counts.total - counts.ran} of ${counts.total} subagents did not finish`;
  }
  return undefined;
}

export function anomalyLineForDenial(reason: "blocked" | "declined"): string {
  return reason;
}

function emptyEntry(name: string): ToolActivityEntry {
  return { name, count: 0, singleLine: "", detailLines: [], anomalyLines: [] };
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

function settledSingleLine(name: string, args: unknown, result: unknown): string {
  if (name === "edit" || name === "dispatch_subagents") {
    return toolResultLine({ type: "tool-result", name, result });
  }
  if (name === "write_file") {
    // Failed/diagnostics verification is a TREE_BRANCH line, not the inline suffix
    // toolResultLine would add — the main line stays the bare done text.
    if (writeFileAnomaly(result) !== undefined) return "✓ write_file done";
    return toolResultLine({ type: "tool-result", name, result });
  }
  return summarizeArgs(name, args);
}

export function recordCall(
  entries: ToolActivityEntry[],
  name: string,
  args: unknown,
): ToolActivityEntry[] {
  return mapEntry(
    entries,
    name,
    (entry) => ({
      ...entry,
      count: entry.count + 1,
      singleLine: entry.singleLine.length > 0 ? entry.singleLine : summarizeArgs(name, args),
    }),
    name === "dispatch_subagents",
  );
}

export function recordResult(
  entries: ToolActivityEntry[],
  name: string,
  args: unknown,
  result: unknown,
): ToolActivityEntry[] {
  const anomaly = anomalyLineForResult(name, args, result);
  const details = detailLinesForResult(name, result);
  return mapEntry(
    entries,
    name,
    (entry) => {
      const count = entry.count + 1;
      return {
        ...entry,
        count,
        singleLine: settledSingleLine(name, args, result),
        // Per-call grep/glob hits only survive on a single-call group; a repeat drops them
        // back to a bare aggregate count, same as every other tool.
        detailLines: count === 1 ? details : [],
        anomalyLines: anomaly === undefined ? entry.anomalyLines : [...entry.anomalyLines, anomaly],
      };
    },
    name === "dispatch_subagents",
  );
}

export function recordDenial(
  entries: ToolActivityEntry[],
  name: string,
  reason: "blocked" | "declined",
): ToolActivityEntry[] {
  const labels = TOOL_LABELS[name];
  return mapEntry(
    entries,
    name,
    (entry) => ({
      ...entry,
      count: entry.count + 1,
      singleLine: entry.singleLine.length > 0 ? entry.singleLine : (labels?.verb ?? name),
      anomalyLines: [...entry.anomalyLines, anomalyLineForDenial(reason)],
    }),
    name === "dispatch_subagents",
  );
}

function aggregateLine(entry: ToolActivityEntry): string {
  if (entry.count === 1) return entry.singleLine;
  const labels = TOOL_LABELS[entry.name];
  if (labels === undefined) return `${entry.name} ×${entry.count}`;
  return `${labels.verb} ${entry.count} ${labels.noun}`;
}

function cappedSubLines(lines: string[]): string[] {
  if (lines.length <= SUB_LINE_CAP) return lines;
  const kept = lines.slice(0, SUB_LINE_CAP - 1);
  return [...kept, `…and ${lines.length - kept.length} more`];
}

export function renderToolActivity(entries: ToolActivityEntry[]): string[] {
  return entries.map((entry) => {
    const subs = cappedSubLines([...entry.detailLines, ...entry.anomalyLines]);
    if (subs.length === 0) return aggregateLine(entry);
    return [aggregateLine(entry), ...subs.map((line) => `${TREE_BRANCH}${line}`)].join("\n");
  });
}
