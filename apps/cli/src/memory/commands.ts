import { setConfigValue } from "../config/config";
import { truncate } from "../truncate";
import {
  approvePending,
  diffPending,
  listPending,
  type PendingWrite,
  pendingLabel,
  rejectPending,
  resolvePendingRef,
} from "./pending";

export type MemoryCommandDeps = { configDir: string };

// One output line plus whether it is secondary to the answer rather than the answer itself
// (docs/design/tui.md's own muted role: hints, footers, empty states). The plain CLI path drops the
// flag and prints `text`; the TUI passes it straight to `transcript-append`'s own `muted`. A flag
// here rather than a decision at either call site because which line is secondary is a property of
// what the line says, and both surfaces would otherwise have to re-derive it from line order.
export type MemoryLine = { text: string; muted?: boolean };

// One row of the /memory panel (memoryPanelRows below), the same producer-side shape McpPanelRow
// has: this file owns the data, tui/util/format.ts owns how it renders.
export type MemoryPanelRow = {
  id: string;
  action: PendingWrite["action"];
  /** "USER.md" | "MEMORY.md" | "<project>/MEMORY.md" — pendingLabel's own output. */
  file: string;
  /** The text the write is about: what gets added, what gets removed, or "old → new". */
  detail: string;
  reason: string;
  durable: boolean;
};

// Enough of the 12-hex id to type back into `/memory diff|approve|reject <id>` (resolvePendingRef
// accepts any unambiguous prefix of 4 or more), short enough that the id stops being the widest
// column in a listing whose point is the write itself. A prefix that ever did collide resolves to
// "Ambiguous id" rather than to the wrong entry, so this degrades loudly.
const SHORT_ID = 7;
const ACTION_WIDTH = 8;
const FILE_WIDTH = 22;

// `width - 1`, not `width`: truncate appends its ellipsis AFTER the cut, so a string cut at the
// full width comes back one char wider than the column and the next column starts one place late.
function column(value: string, width: number): string {
  return truncate(value, width - 1).padEnd(width);
}

function writeDetail(p: PendingWrite): string {
  if (p.action === "add") return p.content ?? "";
  if (p.action === "remove") return p.target ?? "";
  return `${truncate(p.target ?? "", 40)} → ${truncate(p.content ?? "", 40)}`;
}

// The scope is deliberately absent: `pendingLabel` already distinguishes all three ("USER.md",
// "MEMORY.md", "<project>/MEMORY.md"), and a `[memory-project]` bracket in front of
// "harness/MEMORY.md" only repeated it. The project half is what a reviewer actually needs — a
// memory-project write staged from a DIFFERENT repo than the one this listing runs in is otherwise
// indistinguishable from one targeting the current repo.
function summaryLine(p: PendingWrite): MemoryLine {
  return {
    text: `${p.id.slice(0, SHORT_ID)}  ${column(p.action, ACTION_WIDTH)}${column(pendingLabel(p), FILE_WIDTH)}${truncate(writeDetail(p), 60)}`,
  };
}

// The panel's rows, read from disk at the moment /memory opens — unlike skillsPanelRows, which
// reads a registry frozen at session start, the staged queue has no session-scoped snapshot: a
// write staged by the turn that just ran is reviewable now, and that is the whole point of the gate.
export function memoryPanelRows(deps: MemoryCommandDeps): MemoryPanelRow[] {
  return listPending(deps.configDir).map((p) => ({
    id: p.id,
    action: p.action,
    file: pendingLabel(p),
    detail: writeDetail(p),
    reason: p.reason,
    durable: p.durable,
  }));
}

// The panel's own diff for one row, by id. Returns the failure as lines rather than throwing, for
// forEachMatch's own reason: diffPending re-runs computeWrite against the CURRENT live file, which
// can legitimately fail for a write whose target moved since it was staged.
export function memoryDiffLines(deps: MemoryCommandDeps, id: string): string[] {
  return forEachMatch(
    deps.configDir,
    id,
    "diff",
    false,
    (p) => diffPending(deps.configDir, p).lines,
  ).map((line) => line.text);
}

const ID_ARG_RE = /^(all|[0-9a-f]{4,40})$/;
const ON_OFF_RE = /^(on|off)$/;

// The gate SLASH_COMMANDS entries in cli.ts run before decideMemoryCommand is ever called (per
// SlashCommand's own anti-hijack comment: "the command forms are exact and small") — this is that
// predicate, kept here rather than duplicated in cli.ts so it can be unit-tested against the exact
// strings a user types, independent of the Map lookup that dispatches to it.
export function memoryCommandAccepts(args: string[]): boolean {
  const [sub, ...rest] = args;
  // The bare and `list` forms open the panel on the TUI path and print the listing on the plain
  // one, the same split /skills' own accepts predicate makes for the same two surfaces.
  if (sub === undefined || sub === "list" || sub === "pending") return rest.length === 0;
  // Same `all|<hex>` shape as approve/reject, not diff's own older hex-only form: `diff all`
  // renders every staged write's diff in one call, the same way `approve all`/`reject all`
  // already act on every staged write.
  if (sub === "diff" || sub === "approve" || sub === "reject")
    return rest.length === 1 && ID_ARG_RE.test(rest[0] ?? "");
  if (sub === "approval" || sub === "archivist")
    return rest.length === 1 && ON_OFF_RE.test(rest[0] ?? "");
  return false;
}

// Shared by diff/approve/reject (byte-identical across all three until this collapsed them):
// resolve the ref, report "no match" once, then run `act` against each match with the same
// per-entry try/catch. `act` can throw for one entry — a diff's target text gone stale (another
// pending write for the same scope already consolidated it), an approve's cap exceeded, a
// reject's .pending file already gone (a concurrent process rejected/removed it first) — and that
// throw must not discard the lines already collected for entries processed before it in an "all"
// batch, or the user could not tell which of N entries, if any, actually succeeded.
// `separateEntries` reproduces diff's own blank-line-per-entry spacing (its multi-line diffs need
// visual separation an approve/reject one-liner doesn't).
function forEachMatch(
  configDir: string,
  ref: string,
  verb: string,
  separateEntries: boolean,
  act: (p: PendingWrite) => string[],
): MemoryLine[] {
  const matches = resolvePendingRef(configDir, ref);
  if (matches.length === 0) return [{ text: `No staged write matches "${ref}".` }];
  const lines: MemoryLine[] = [];
  for (const p of matches) {
    try {
      lines.push(...act(p).map((text) => ({ text })));
    } catch (err) {
      lines.push({
        text: `Could not ${verb} ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (separateEntries) lines.push({ text: "" });
  }
  return lines;
}

// One count, not one line per entry: `reject all` over a full queue printed twenty near-identical
// "Rejected <hex>." lines that nobody reads and that pushed everything else off the viewport. The
// ids are gone from the success path on purpose — the user either named one (and knows which) or
// asked for all of them. Failures stay per-entry, because which of N failed is exactly the thing a
// count cannot say.
function countedResult(
  configDir: string,
  ref: string,
  verb: string,
  pastTense: string,
  act: (p: PendingWrite) => void,
): { lines: MemoryLine[] } {
  const matches = resolvePendingRef(configDir, ref);
  if (matches.length === 0) return { lines: [{ text: `No staged write matches "${ref}".` }] };
  const failures: MemoryLine[] = [];
  let done = 0;
  for (const p of matches) {
    try {
      act(p);
      done += 1;
    } catch (err) {
      failures.push({
        text: `Could not ${verb} ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const counted: MemoryLine[] =
    done === 0 ? [] : [{ text: `${done} ${done === 1 ? "memory" : "memories"} ${pastTense}.` }];
  return { lines: [...counted, ...failures] };
}

const USAGE =
  "Usage: /memory | pending | diff <id|all> | approve <id|all> | reject <id|all> | approval on|off | archivist on|off";

// decide*, not apply* — prints nothing itself, following tui/commands.ts's own decision/
// presentation split, so /memory can render into the live TUI transcript exactly the same way
// /mode, /undo, /rewind and /restore already do.
export function decideMemoryCommand(
  args: string[],
  deps: MemoryCommandDeps,
): { lines: MemoryLine[] } {
  const [sub, ...rest] = args;

  // The TUI intercepts the bare and `list` forms and opens the panel instead (cli.ts's own
  // tuiHandlers entry), so those two only reach here through the SLASH_COMMANDS fallback. `pending`
  // always lands here: it is the flat, copy-pasteable listing, and the panel is the one you review in.
  if (sub === undefined || sub === "list" || sub === "pending") {
    const pending = listPending(deps.configDir);
    if (pending.length === 0) return { lines: [{ text: "No staged memory writes.", muted: true }] };
    return {
      lines: [
        ...pending.map(summaryLine),
        { text: "/memory diff <id> · approve <id|all> · reject <id|all>", muted: true },
      ],
    };
  }

  if (sub === "diff" && rest.length === 1) {
    // diffPending re-runs computeWrite against the CURRENT live file (correct — approve-time
    // re-check, store.ts's own comment on approvePending explains why), which is what can throw.
    return {
      lines: forEachMatch(
        deps.configDir,
        rest[0] as string,
        "diff",
        true,
        (p) => diffPending(deps.configDir, p).lines,
      ),
    };
  }

  if (sub === "approve" && rest.length === 1) {
    return countedResult(deps.configDir, rest[0] as string, "approve", "approved", (p) => {
      approvePending(deps.configDir, p);
    });
  }

  if (sub === "reject" && rest.length === 1) {
    // rejectPending is a raw unlinkSync with no existence check, so an entry whose .pending file
    // is already gone throws — the one failure countedResult's own comment describes for reject.
    return countedResult(deps.configDir, rest[0] as string, "reject", "rejected", (p) => {
      rejectPending(deps.configDir, p);
    });
  }

  if (sub === "approval" && ON_OFF_RE.test(rest[0] ?? "")) {
    setConfigValue("SERI_MEMORY_APPROVAL", rest[0] === "on" ? "true" : "false", deps.configDir);
    return { lines: [{ text: `Memory approval gate is now ${rest[0]}.` }] };
  }

  if (sub === "archivist" && ON_OFF_RE.test(rest[0] ?? "")) {
    setConfigValue("SERI_ARCHIVIST_ENABLED", rest[0] === "on" ? "true" : "false", deps.configDir);
    return { lines: [{ text: `Archivist is now ${rest[0]}.` }] };
  }

  return { lines: [{ text: USAGE, muted: true }] };
}
