import type { RestorePlan, RestoreResult } from "../checkpoint/checkpoint";
import { fileChangeFromTool, fileChangePlainText } from "../fileChange";
import type { LoopEvent } from "../loop/loop";
import type { ArchivistReport } from "../memory/archivist";
import type { CostReport } from "../provider/cost";
import type { DispatchResult } from "../subagents/dispatch";
import { ARCHIVIST_MARK } from "../tui/theme/theme";
import { formatTodoLines, parseTodoList } from "../todo/list";
import { TODO_TOOL_NAME } from "../todo/tool";
import { type CheckOutcome, writeFileVerification } from "../verify/outcome";

export const USAGE = `Usage:
  seri <task>                     send a task to the model
  seri                            (in a terminal) open the TUI with an empty input box
  seri --continue [task]          continue the most recent session
  seri --resume <id> [task]       continue that session
  seri serve                      start the foreground loopback daemon for this profile
  seri exec <task>                run one task through an already-running daemon
  seri doctor                     print a local install and config report
  seri update                     replace this binary from GitHub Releases
  seri --version | --help

Options:
  --max-turns <n>                 stop after n model turns (default 500)
  --profile <name>                use the named profile's config, auth, permissions, sessions
                                    and checkpoints (or SERI_PROFILE; the flag wins)
  --dangerously-skip-permissions  run every tool with no approval prompt (attended use only)
  --permission-prompts <mode>     none denies anything that would prompt; the permission mode still decides
  --                              everything after this is the task, flags included:
                                    seri -- fix the --help output`;

export function usageError(message: string): number {
  console.error(message);
  console.error(USAGE);
  return 2;
}

// A model-supplied tool name can contain C0/DEL and paint or scroll the TTY.
export function escapeControlChars(text: string): string {
  return text.replace(
    /[\x00-\x1f\x7f]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

const MAX_PROMPT_ARGS_LENGTH = 200;
export function truncateArgsDisplay(args: unknown): string {
  // JSON.stringify(undefined) returns the value undefined, not a string, so `.length` throws.
  const json = JSON.stringify(args) ?? "undefined";
  return json.length > MAX_PROMPT_ARGS_LENGTH ? `${json.slice(0, MAX_PROMPT_ARGS_LENGTH)}…` : json;
}

export function approvalPromptText(
  toolName: string,
  args: unknown,
  offersAlways: boolean,
  classifierReason?: string,
): string {
  const question = `Approve ${escapeControlChars(toolName)}(${truncateArgsDisplay(args)})? ${
    offersAlways ? "[y]es / [a]lways (saved for this project) / [N]o" : "[y]es / [N]o"
  } `;
  if (classifierReason === undefined || classifierReason.length === 0) return question;
  return `Classifier: ${escapeControlChars(classifierReason)}\n${question}`;
}

// A raw console.error between enterAltScreen() and the OpenTUI mount lands on the alt-screen buffer and is gone when the first frame paints.
export function printWarning(message: string, sink: (line: string) => void = console.error): void {
  sink(`⚠ ${message}`);
}

export function printGrantPersisted(name: string, worktree: string): void {
  console.log(
    `  saved for ${worktree} — undo by editing permissions.yaml, or with /permissions inside the TUI (remove ${escapeControlChars(name)})`,
  );
}

export function printPreApproved(
  tools: readonly string[],
  sink: (line: string) => void = console.log,
): void {
  sink(
    `Pre-approved without asking: ${tools.map(escapeControlChars).join(", ")} — permissions.yaml, or /permissions inside the TUI`,
  );
}

export function undoPlanLines(plan: RestorePlan, sink: (line: string) => void = console.log): void {
  if (plan.diff) sink(plan.diff);
  for (const path of plan.restored) sink(`restored ${path}`);
  for (const path of plan.deleted) sink(`deleted  ${path}`);
  if (plan.ignored.length > 0) sink(`not restored (gitignored): ${plan.ignored.join(", ")}`);
  if (plan.preserved.length > 0) {
    sink(`preserved (no proof seri wrote them, or edited since): ${plan.preserved.join(", ")}`);
  }
}

export function recoveryLines(
  result: RestoreResult,
  sink: (line: string) => void = console.log,
): void {
  sink(
    `The state this replaced is commit ${result.preUndoCommit}. To get it back in this session, run:`,
  );
  sink(`  ${result.recoverCommand}`);
}

function seconds(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

function verificationSuffix(verification: CheckOutcome): string {
  switch (verification.status) {
    case "ok":
      return ` (checked in ${seconds(verification.elapsedMs)}, no diagnostics)`;
    case "diagnostics": {
      const shown = verification.diagnostics.length;
      const count =
        shown < verification.total ? `${shown} of ${verification.total}` : `${verification.total}`;
      const noun = verification.total === 1 ? "diagnostic" : "diagnostics";
      const incomplete = verification.truncated ? ", list incomplete" : "";
      return ` (${count} ${noun} in ${seconds(verification.elapsedMs)}${incomplete})`;
    }
    case "failed":
      return ` — check failed: ${verification.reason}`;
    case "unavailable":
      return "";
  }
}

function dispatchSummary(
  result: unknown,
): { ran: number; total: number; tokens: number | undefined } | undefined {
  const value = result as Partial<DispatchResult> | undefined;
  if (!Array.isArray(value?.results)) return undefined;
  const ran = value.results.filter((r) => r.doneReason !== undefined).length;
  const tokens = value.totalUsage?.totalTokens;
  return {
    ran,
    total: value.results.length,
    tokens: typeof tokens === "number" ? tokens : undefined,
  };
}

export function toolResultLine(event: Extract<LoopEvent, { type: "tool-result" }>): string {
  if (event.name === "edit") return "✓ edit done (text returned, nothing written)";
  if (event.name === TODO_TOOL_NAME) {
    const list = parseTodoList(event.result);
    if (list !== undefined) {
      const lines = formatTodoLines(list);
      return lines.length === 0 ? "→ todo" : `→ todo\n${lines.join("\n")}`;
    }
  }
  const dispatch = event.name === "dispatch_subagents" ? dispatchSummary(event.result) : undefined;
  if (dispatch !== undefined) {
    const tokens = dispatch.tokens === undefined ? "" : `, ${dispatch.tokens} tokens`;
    const tasks =
      dispatch.ran === dispatch.total
        ? `${dispatch.total} ${dispatch.total === 1 ? "task" : "tasks"}`
        : `${dispatch.ran} of ${dispatch.total} tasks`;
    return `✓ Dispatched subagents done (${tasks}${tokens})`;
  }
  const verification = writeFileVerification(event.result);
  return `✓ ${event.name} done${verification === undefined ? "" : verificationSuffix(verification)}`;
}

export function toolAllowedLine(name: string): string {
  return `✓ ${escapeControlChars(name)} approved for the rest of this run`;
}

export function printEvent(event: LoopEvent): void {
  switch (event.type) {
    case "text-delta":
      process.stdout.write(event.text);
      break;
    case "reasoning-delta":
      break;
    case "tool-call":
      console.log(`\n→ ${event.name}(${JSON.stringify(event.args)})`);
      break;
    case "tool-result": {
      console.log(toolResultLine(event));
      const change = fileChangeFromTool(event.name, {}, event.result);
      if (change !== undefined) console.log(fileChangePlainText(change));
      break;
    }
    case "permission-denied":
      console.log(`✗ ${event.name} blocked`);
      break;
    case "tool-allowed":
      console.log(toolAllowedLine(event.name));
      break;
    case "compacted":
      console.log(`\n⚙ compacted ${event.evictedCount} messages`);
      break;
    // The SDK retry callback is handed neither the error nor the delay, so this line cannot name which of 429 or 5xx it was.
    case "retry":
      console.log(`\n↻ rate-limited or unavailable; retrying (attempt ${event.attempt})`);
      break;
    case "usage":
      break;
    case "messages-updated":
      break;
    case "done":
      console.log(`\n(done: ${event.reason})`);
      if (event.reason === "repeated-denials") {
        console.log("Several tool calls were refused in a row, so the run stopped. Run /mode to");
        console.log(
          "switch to auto, or answer 'a' at the next write_file/edit prompt to allow it.",
        );
      }
      break;
    case "error":
      console.error(event.error);
      break;
    default: {
      const _unhandled: never = event;
      break;
    }
  }
}

export type RunUsage = { inputTokens: number | undefined; outputTokens: number | undefined };

export function printUsage(usage: RunUsage): void {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${usage.inputTokens} in`);
  if (usage.outputTokens !== undefined) parts.push(`${usage.outputTokens} out`);
  if (parts.length === 0) return;
  console.log(`\n(tokens: ${parts.join(", ")})`);
}

export function printCost(cost: CostReport): void {
  if (cost.status === "included") {
    console.log("(cost: included)");
    return;
  }
  if (cost.status === "unknown") {
    console.log(
      cost.amountUsd === undefined
        ? "(cost: unknown)"
        : `(cost: ≥ $${cost.amountUsd.toFixed(4)}, partially unknown)`,
    );
    return;
  }
  if (cost.amountUsd === undefined) {
    console.log("(cost: unknown)");
    return;
  }
  const amount = `$${cost.amountUsd.toFixed(4)}`;
  console.log(cost.status === "estimated" ? `(cost: ~${amount} (estimated))` : `(cost: ${amount})`);
}

function costFragment(cost: CostReport): string {
  if (cost.status === "included") return "cost: included";
  if (cost.amountUsd === undefined) return "cost: unknown";
  const amount = `$${cost.amountUsd.toFixed(4)}`;
  return cost.status === "estimated" ? `cost: ~${amount} (estimated)` : `cost: ${amount}`;
}

export function archivistStatsLine(report: ArchivistReport): string {
  const tokenParts: string[] = [];
  if (report.usage.inputTokens !== undefined) tokenParts.push(`${report.usage.inputTokens} in`);
  if (report.usage.outputTokens !== undefined) tokenParts.push(`${report.usage.outputTokens} out`);
  const tokens = tokenParts.length > 0 ? `, tokens: ${tokenParts.join(", ")}` : "";
  const cost = report.cost === undefined ? "" : `, ${costFragment(report.cost)}`;
  const calls = `${report.toolCallsMade} tool call${report.toolCallsMade === 1 ? "" : "s"}`;
  return `${ARCHIVIST_MARK}(archivist: ${report.trigger} trigger, ${calls}${tokens}${cost})`;
}

const ARCHIVIST_STAGED_KINDS = [
  { kind: "memory", noun: "memory write", review: "/memory pending" },
  { kind: "skill", noun: "skill", review: "/skills pending" },
] as const;

export function archivistStagedLines(report: ArchivistReport): string[] {
  const lines: string[] = [];
  for (const row of ARCHIVIST_STAGED_KINDS) {
    const of = report.staged.filter((w) => w.kind === row.kind);
    if (of.length === 0) continue;
    const named = of.map((w) => `${w.label} (${w.id})`).join(", ");
    const count = `${of.length} ${row.noun}${of.length === 1 ? "" : "s"}`;
    lines.push(`${ARCHIVIST_MARK}staged ${count}: ${named} · ${row.review}`);
  }
  return lines;
}

export function archivistLine(report: ArchivistReport): string {
  const parts = [archivistStatsLine(report), ...archivistStagedLines(report)];
  if (report.summary !== undefined) parts.push(`  ${report.summary}`);
  return parts.join("\n");
}

export function pendingQueueNotice(memoryCount: number, skillCount: number): string | undefined {
  const parts: string[] = [];
  if (memoryCount > 0) parts.push(`${memoryCount} memory write${memoryCount === 1 ? "" : "s"}`);
  if (skillCount > 0) parts.push(`${skillCount} skill${skillCount === 1 ? "" : "s"}`);
  if (parts.length === 0) return undefined;
  const review = [
    memoryCount > 0 ? "/memory pending" : undefined,
    skillCount > 0 ? "/skills pending" : undefined,
  ].filter((c) => c !== undefined);
  return `! ${parts.join(" and ")} waiting for review · ${review.join(", ")}`;
}
