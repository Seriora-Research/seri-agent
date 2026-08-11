import { setConfigValue } from "../config/config";
import {
  approvePending,
  diffPending,
  listPending,
  pendingLabel,
  type PendingWrite,
  rejectPending,
  resolvePendingRef,
} from "./pending";
import { truncate } from "./store";

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

// decide*, not apply* — prints nothing itself, following tui/commands.ts's own decision/
// presentation split, so /memory can render into the live TUI transcript exactly the same way
// /mode, /undo, /rewind and /restore already do.
export function decideMemoryCommand(
  args: string[],
  deps: MemoryCommandDeps,
): { lines: string[]; changed: boolean } {
  const [sub, ...rest] = args;

  if (sub === "pending") {
    const pending = listPending(deps.configDir);
    if (pending.length === 0) return { lines: ["No staged memory writes."], changed: false };
    return { lines: pending.map(summaryLine), changed: false };
  }

  if (sub === "diff" && rest.length === 1) {
    const matches = resolvePendingRef(deps.configDir, rest[0]);
    if (matches.length === 0)
      return { lines: [`No staged write matches "${rest[0]}".`], changed: false };
    const lines: string[] = [];
    // Per-entry try/catch, the same shape "approve" already uses below: diffPending re-runs
    // computeWrite against the CURRENT live file (correct — approve-time re-check, store.ts's own
    // comment on approvePending explains why), which can throw for one entry (its target text went
    // stale, e.g. another pending write for the same scope already consolidated it) without that
    // throw discarding every diff already collected for entries processed before it in "diff all".
    for (const p of matches) {
      try {
        lines.push(...diffPending(deps.configDir, p).lines, "");
      } catch (err) {
        lines.push(
          `Could not diff ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
          "",
        );
      }
    }
    return { lines, changed: false };
  }

  if (sub === "approve" && rest.length === 1) {
    const matches = resolvePendingRef(deps.configDir, rest[0]);
    if (matches.length === 0)
      return { lines: [`No staged write matches "${rest[0]}".`], changed: false };
    const lines: string[] = [];
    let changed = false;
    for (const p of matches) {
      try {
        approvePending(deps.configDir, p);
        lines.push(`Approved ${p.id}: wrote ${pendingLabel(p)}.`);
        changed = true;
      } catch (err) {
        lines.push(
          `Could not approve ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { lines, changed };
  }

  if (sub === "reject" && rest.length === 1) {
    const matches = resolvePendingRef(deps.configDir, rest[0]);
    if (matches.length === 0)
      return { lines: [`No staged write matches "${rest[0]}".`], changed: false };
    const lines: string[] = [];
    let changed = false;
    // Per-entry try/catch, the same shape "approve"/"diff" already use above: rejectPending is a
    // raw unlinkSync with no existence check, so an entry already removed by a concurrent process
    // (or a .pending file gone for any other reason) throws — without this, that one throw would
    // abort "reject all" with zero output, leaving the user unable to tell which of the N entries,
    // if any, were actually rejected before it.
    for (const p of matches) {
      try {
        rejectPending(deps.configDir, p);
        lines.push(`Rejected ${p.id}.`);
        changed = true;
      } catch (err) {
        lines.push(`Could not reject ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { lines, changed };
  }

  if (sub === "approval" && ON_OFF_RE.test(rest[0] ?? "")) {
    setConfigValue("SERI_MEMORY_APPROVAL", rest[0] === "on" ? "true" : "false", deps.configDir);
    return { lines: [`Memory approval gate is now ${rest[0]}.`], changed: true };
  }

  if (sub === "archivist" && ON_OFF_RE.test(rest[0] ?? "")) {
    setConfigValue("SERI_ARCHIVIST_ENABLED", rest[0] === "on" ? "true" : "false", deps.configDir);
    return { lines: [`Archivist is now ${rest[0]}.`], changed: true };
  }

  return {
    lines: [
      "Usage: /memory pending | diff <id|all> | approve <id|all> | reject <id|all> | approval on|off | archivist on|off",
    ],
    changed: false,
  };
}
