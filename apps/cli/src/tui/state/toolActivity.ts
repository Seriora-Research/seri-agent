// Pure TUI tool-call/result accumulation — no Ink/React import. Live rendering reads
// `pendingTool` (app.tsx) for the in-flight call, and `renderLiveToolActivity` of this
// accumulator for settled groups during the turn. `renderToolActivity` is also what the
// reducer flushes into muted transcript lines on done/turn-ended. Aggregation is by exact
// tool name (every TOOL_LABELS entry — not a Read special-case), except every `mcp_`-prefixed
// name, which folds into one bucket (`groupKey` below): the model's tool array already
// collapses every MCP call behind the single `mcp` dispatcher (mcp/tool.ts), so the transcript
// reads the same way, one line naming how many, with each call's own composed name as a child.
// `dispatch_subagents` is never recorded here: recordCall and recordResult both early-return, so
// the TUI does not paint a dispatch settled line. `alwaysAppend` stays on mapEntry's other
// callers so a later regression cannot merge a dispatch row into another group.
import path from "node:path";
import { escapeControlChars, toolResultLine } from "../../cli/output";
import { isMcpToolName } from "../../mcp/types";
import type { DispatchResult } from "../../subagents/dispatch";
import type { GlobResult } from "../../tools/glob";
import type { GrepResult } from "../../tools/grep";
import type { ProcessResult } from "../../tools/spawnCollect";
import { writeFileVerification } from "../../verify/outcome";
import { TOOL_INDENT } from "../theme/spacing";
import { TREE_BRANCH, TREE_MID } from "../theme/theme";

export type ToolActivityEntry = {
  name: string;
  count: number;
  // The `→ name(arg)` line the group paints above its own result line, taken from the FIRST call
  // in the group: every later call folds into the count, so one representative argument is all
  // this line can honestly show. The tool keeps the name the model called it by, which is what
  // cli/output.ts's own `printEvent` already writes on the non-interactive path — the two
  // surfaces name a call identically.
  callLine: string;
  singleLine: string;
  detailLines: string[];
  anomalyLines: string[];
  // True after recordCall until the matching recordResult/recordDenial settles it.
  // Without this, wiring recordCall on tool-call would double-count every successful call.
  open?: boolean;
};

// Every mcp_-prefixed tool name groups under this one bucket instead of its own exact name —
// see the header comment above for why. Everything else groups by its own exact name unchanged.
const MCP_GROUP_KEY = "mcp";

function groupKey(name: string): string {
  return isMcpToolName(name) ? MCP_GROUP_KEY : name;
}

// `one`/`many` are both spelled out rather than derived by appending an "s": the result line now
// carries the count on every group, singular included ("Ran 1 shell command"), and a trailing-s
// rule is a shape assumption that holds for these seven entries and breaks on the first noun that
// does not pluralise that way.
//
// `settles` marks the two tools whose settled line is built from the RESULT rather than from the
// arguments, so it says something a count cannot ("nothing written", a write verification). Every
// other tool's settled line is its own arguments, which the `→ name(arg)` line above already
// shows, so repeating it under itself would be the same fact twice.
export const TOOL_LABELS: Record<
  string,
  { verb: string; one: string; many: string; settles?: true }
> = {
  read_file: { verb: "Read", one: "file", many: "files" },
  grep: { verb: "Searched", one: "file", many: "files" },
  glob: { verb: "Searched", one: "file", many: "files" },
  bash: { verb: "Ran", one: "shell command", many: "shell commands" },
  powershell: { verb: "Ran", one: "shell command", many: "shell commands" },
  write_file: { verb: "Wrote", one: "file", many: "files", settles: true },
  edit: { verb: "Edited", one: "edit", many: "edits", settles: true },
  // The group header for MCP_GROUP_KEY, so aggregateLine reads "Ran MCP 3 tools" instead of
  // falling through to its `${name} ×${count}` unknown-key case. Deliberately no bullet on this
  // line — a reference mock for this feature puts `●` (BULLET, TranscriptList.tsx) on the group
  // header, which is reserved for "this is the assistant's answer"; a tool group is muted and
  // unmarked like every other TOOL_LABELS group, so it never reads as one.
  mcp: { verb: "Ran MCP", one: "tool", many: "tools" },
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

// Escape first so a live status line (app.tsx reads summarizeArgs directly) never paints a
// raw ESC/BEL, then cap so the escaped form is what the 60-char budget measures.
function display(text: string): string {
  return escapeControlChars(text);
}

// cwd-relative when the path is inside the process cwd; otherwise the original string
// (a relative() that walks out via `..` is not a useful display path).
export function trimPath(p: string): string {
  const relative = path.relative(process.cwd(), p);
  if (relative === "" || relative.startsWith("..")) return p;
  return relative;
}

// The one argument worth naming in a call line, escaped and capped. Empty for a tool whose
// arguments have no single representative value (edit's per-hunk list, a bare MCP dispatch).
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

// The in-flight status line (app.tsx's pendingTool, ChildTranscript, SubagentPanel) — a verb and
// its argument, which is the only thing known about a call that has not returned yet.
export function summarizeArgs(name: string, args: unknown): string {
  const labels = TOOL_LABELS[name];
  if (name === "edit") return labels.verb;
  if (name === "dispatch_subagents") return "Dispatched subagents";
  if (labels === undefined) return name;
  return `${labels.verb} ${primaryArg(name, args)}`.trimEnd();
}

// A settled group's own header. Mirrors cli/output.ts's `printEvent` tool-call line, so the TUI
// and the non-interactive path name a call the same way; the argument is the display form rather
// than that path's raw JSON, because this one has a transcript column budget to live inside.
export function toolCallLine(name: string, args: unknown): string {
  const arg = primaryArg(name, args);
  const called = display(name);
  return arg === "" ? `→ ${called}` : `→ ${called}(${arg})`;
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

export function anomalyLineForDenial(reason: "blocked" | "declined" | "hook"): string {
  // "blocked" and "declined" each read as a complete statement about the call. "hook" names an
  // actor instead, so on its own it tells a reader who did it and not what was done — it needs the
  // verb the other two carry implicitly.
  return reason === "hook" ? "blocked by hook" : reason;
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

// First call in the group wins, so a group's header keeps naming the call a reader saw start
// rather than sliding to whichever call happened to settle last.
function keepFirst(existing: string, next: string): string {
  return existing.length > 0 ? existing : next;
}

function settleCount(entry: ToolActivityEntry): number {
  return entry.open ? entry.count : entry.count + 1;
}

// success_check: exactly one TREE_BRANCH per name-group. Keep the first anomaly.
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

function settledSingleLine(name: string, args: unknown, result: unknown): string {
  if (name === "edit") {
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
  // dispatch_subagents is never recorded; its TUI surface is the child roster, not a
  // settled transcript line. Recording the call here would append a second alwaysAppend entry.
  if (name === "dispatch_subagents") return entries;
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
        // grep/glob's detail lines belong to one search and are dropped the instant a second
        // call turns this into an aggregate. MCP accumulates instead (mcpDetailLines below), so
        // a call starting mid-accumulation must not wipe what already settled.
        detailLines: isMcpToolName(name) ? entry.detailLines : count > 1 ? [] : entry.detailLines,
      };
    },
    false,
  );
}

// MCP is the one case where the composed name IS the sub-line, not a derived summary of the
// result the way grep/glob's matched paths are — so unlike them, an MCP group accumulates every
// call's name across settles instead of resetting on the second one. The first call's own name
// lives only in singleLine (a single call shows no children at all — count === 1 below), so it
// is folded back in here the moment a second call turns the entry into a real group.
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
  if (name === "dispatch_subagents") return entries;
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
        // A result can be the first thing a group sees: a denial-then-result ordering reaches
        // mapEntry here without recordCall having run for this name.
        callLine: keepFirst(entry.callLine, toolCallLine(name, args)),
        singleLine: settledSingleLine(name, args, result),
        // Per-call grep/glob hits only survive on a single-call group; a repeat drops them
        // back to a bare aggregate count, same as every other tool. MCP is the exception,
        // handled by mcpDetailLines.
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

export function recordDenial(
  entries: ToolActivityEntry[],
  name: string,
  reason: "blocked" | "declined" | "hook",
): ToolActivityEntry[] {
  const labels = TOOL_LABELS[name];
  return mapEntry(
    entries,
    groupKey(name),
    (entry) => ({
      ...entry,
      count: settleCount(entry),
      open: false,
      callLine: keepFirst(entry.callLine, `→ ${display(name)}`),
      singleLine: keepFirst(entry.singleLine, labels?.verb ?? name),
      anomalyLines: appendAnomaly(entry.anomalyLines, anomalyLineForDenial(reason)),
    }),
    name === "dispatch_subagents",
  );
}

// The line under the call line. It carries the count on every group, singular included, because
// the call line above already carries the arguments. A `settles` tool is the exception: a single
// call's settled text reports something about the result that no count can.
function aggregateLine(entry: ToolActivityEntry): string {
  const labels = TOOL_LABELS[entry.name];
  if (labels === undefined) return `${entry.name} ×${entry.count}`;
  if (labels.settles === true && entry.count === 1) return entry.singleLine;
  return `${labels.verb} ${entry.count} ${entry.count === 1 ? labels.one : labels.many}`;
}

function cappedSubLines(lines: string[]): string[] {
  if (lines.length <= SUB_LINE_CAP) return lines;
  const kept = lines.slice(0, SUB_LINE_CAP - 1);
  return [...kept, `…and ${lines.length - kept.length} more`];
}
// Two lines per group: the call, then what it did, the second indented under the first so the
// pair reads as one unit instead of two peers. Sub-lines hang off the result line at the same
// indent, keeping the tree glyphs that already distinguish a sample from a complete list.
export function renderToolActivity(entries: ToolActivityEntry[]): string[] {
  return entries.map((entry) => {
    const subs = cappedSubLines([...entry.detailLines, ...entry.anomalyLines].map(display));
    // grep/glob's sub-lines are a sample (up to 3 matched paths out of however many, dropped
    // entirely once count > 1) — TREE_BRANCH on each means "here is some more detail", and stays
    // that way. An MCP group's sub-lines are the complete call list, not a sample, so only there
    // does the tree glyph mean what it says: every child but the last gets TREE_MID, the last
    // TREE_BRANCH.
    const last = subs.length - 1;
    const marked =
      entry.name === MCP_GROUP_KEY
        ? subs.map((line, i) => `${i === last ? TREE_BRANCH : TREE_MID}${line}`)
        : subs.map((line) => `${TREE_BRANCH}${line}`);
    const body = [display(aggregateLine(entry)), ...marked];
    return [entry.callLine, ...body.map((line) => `${TOOL_INDENT}${line}`)].join("\n");
  });
}

// Settled view for live paint. recordCall increments count and sets open before the result;
// skip an open count===1 entry so the first in-flight call is only pendingTool. An open
// follow-up (count>1) paints at count-1 so the group stays on the previous settled line
// (Read a.txt / Ran echo a) until the next result lands as the aggregate (Read 2 files /
// Ran 2 shell commands). Name-agnostic: every TOOL_LABELS group uses the same rule.
export function liveToolActivity(entries: ToolActivityEntry[]): ToolActivityEntry[] {
  const out: ToolActivityEntry[] = [];
  for (const entry of entries) {
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
