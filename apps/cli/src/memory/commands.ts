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

function summaryLine(p: PendingWrite): string {
  const detail =
    p.action === "add"
      ? `add "${truncate(p.content ?? "", 60)}"`
      : p.action === "remove"
        ? `remove "${truncate(p.target ?? "", 60)}"`
        : `replace "${truncate(p.target ?? "", 40)}" -> "${truncate(p.content ?? "", 40)}"`;
  // The target project only shown for memory-project (labelFor's own comment: "USER.md"/"MEMORY.md"
  // for the other two scopes name nothing project-specific) — this is the gap a human reviewer
  // needs closed: a memory-project write staged from a DIFFERENT repo than the one /memory pending
  // is run from is otherwise indistinguishable from one targeting the current repo.
  const target = p.scope === "memory-project" ? ` ${pendingLabel(p)}` : "";
  return `${p.id}  [${p.scope}]${target}  ${detail}`;
}

const ID_ARG_RE = /^(all|[0-9a-f]{4,40})$/;
const ON_OFF_RE = /^(on|off)$/;

// The gate SLASH_COMMANDS entries in cli.ts run before decideMemoryCommand is ever called (per
// SlashCommand's own anti-hijack comment: "the command forms are exact and small") — this is that
// predicate, kept here rather than duplicated in cli.ts so it can be unit-tested against the exact
// strings a user types, independent of the Map lookup that dispatches to it.
export function memoryCommandAccepts(args: string[]): boolean {
  const [sub, ...rest] = args;
  if (sub === "pending") return rest.length === 0;
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
): string[] {
  const matches = resolvePendingRef(configDir, ref);
  if (matches.length === 0) return [`No staged write matches "${ref}".`];
  const lines: string[] = [];
  for (const p of matches) {
    try {
      lines.push(...act(p));
    } catch (err) {
      lines.push(`Could not ${verb} ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (separateEntries) lines.push("");
  }
  return lines;
}

// decide*, not apply* — prints nothing itself, following tui/commands.ts's own decision/
// presentation split, so /memory can render into the live TUI transcript exactly the same way
// /mode, /undo, /rewind and /restore already do.
export function decideMemoryCommand(args: string[], deps: MemoryCommandDeps): { lines: string[] } {
  const [sub, ...rest] = args;

  if (sub === "pending") {
    const pending = listPending(deps.configDir);
    if (pending.length === 0) return { lines: ["No staged memory writes."] };
    return { lines: pending.map(summaryLine) };
  }

  if (sub === "diff" && rest.length === 1) {
    // diffPending re-runs computeWrite against the CURRENT live file (correct — approve-time
    // re-check, store.ts's own comment on approvePending explains why), which is what can throw.
    return {
      lines: forEachMatch(
        deps.configDir,
        rest[0],
        "diff",
        true,
        (p) => diffPending(deps.configDir, p).lines,
      ),
    };
  }

  if (sub === "approve" && rest.length === 1) {
    return {
      lines: forEachMatch(deps.configDir, rest[0], "approve", false, (p) => {
        approvePending(deps.configDir, p);
        return [`Approved ${p.id}: wrote ${pendingLabel(p)}.`];
      }),
    };
  }

  if (sub === "reject" && rest.length === 1) {
    // rejectPending is a raw unlinkSync with no existence check, so an entry whose .pending file
    // is already gone throws — the one failure forEachMatch's own comment describes for reject.
    return {
      lines: forEachMatch(deps.configDir, rest[0], "reject", false, (p) => {
        rejectPending(deps.configDir, p);
        return [`Rejected ${p.id}.`];
      }),
    };
  }

  if (sub === "approval" && ON_OFF_RE.test(rest[0] ?? "")) {
    setConfigValue("SERI_MEMORY_APPROVAL", rest[0] === "on" ? "true" : "false", deps.configDir);
    return { lines: [`Memory approval gate is now ${rest[0]}.`] };
  }

  if (sub === "archivist" && ON_OFF_RE.test(rest[0] ?? "")) {
    setConfigValue("SERI_ARCHIVIST_ENABLED", rest[0] === "on" ? "true" : "false", deps.configDir);
    return { lines: [`Archivist is now ${rest[0]}.`] };
  }

  return {
    lines: [
      "Usage: /memory pending | diff <id|all> | approve <id|all> | reject <id|all> | approval on|off | archivist on|off",
    ],
  };
}
