import { basename } from "node:path";
import { setConfigValue } from "../config/config";
import {
  approvePending,
  diffPending,
  listPending,
  type PendingWrite,
  rejectPending,
  resolvePendingRef,
} from "./pending";

export type MemoryCommandDeps = { configDir: string; worktree: string };

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function summaryLine(p: PendingWrite): string {
  const detail =
    p.action === "add"
      ? `add "${truncate(p.content ?? "", 60)}"`
      : p.action === "remove"
        ? `remove "${truncate(p.target ?? "", 60)}"`
        : `replace "${truncate(p.target ?? "", 40)}" -> "${truncate(p.content ?? "", 40)}"`;
  return `${p.id}  [${p.scope}]  ${detail}`;
}

const HEX_REF_RE = /^[0-9a-f]{4,40}$/;
const ID_ARG_RE = /^(all|[0-9a-f]{4,40})$/;
const ON_OFF_RE = /^(on|off)$/;

// The gate SLASH_COMMANDS entries in cli.ts run before decideMemoryCommand is ever called (per
// SlashCommand's own anti-hijack comment: "the command forms are exact and small") — this is that
// predicate, kept here rather than duplicated in cli.ts so it can be unit-tested against the exact
// strings a user types, independent of the Map lookup that dispatches to it.
export function memoryCommandAccepts(args: string[]): boolean {
  const [sub, ...rest] = args;
  if (sub === "pending") return rest.length === 0;
  if (sub === "diff") return rest.length === 1 && HEX_REF_RE.test(rest[0] ?? "");
  if (sub === "approve" || sub === "reject")
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
    for (const p of matches) lines.push(...diffPending(deps.configDir, p).lines, "");
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
        const { path } = approvePending(deps.configDir, p);
        lines.push(`Approved ${p.id}: wrote ${basename(path)}.`);
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
    for (const p of matches) rejectPending(deps.configDir, p);
    return { lines: matches.map((p) => `Rejected ${p.id}.`), changed: true };
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
      "Usage: /memory pending | diff <id> | approve <id|all> | reject <id|all> | approval on|off | archivist on|off",
    ],
    changed: false,
  };
}
