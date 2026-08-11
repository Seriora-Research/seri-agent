import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { getPendingDir } from "../config/paths";
import { projectKey } from "../permissions/store";
import {
  applyWrite,
  computeWrite,
  loadMemoryFile,
  type MemoryContext,
  type MemoryScope,
  type MemoryWriteRequest,
} from "./store";

export type PendingWrite = {
  id: string; // 12 hex chars: randomBytes(6).toString("hex")
  stagedAt: string;
  scope: MemoryScope;
  action: "add" | "replace" | "remove";
  target?: string;
  content?: string;
  reason: string;
  durable: boolean;
  projectPath?: string; // projectKey(worktree), present iff scope === "memory-project"
  entryDate: string; // the YYYY-MM-DD the entry will carry when applied
};

export function pendingPath(configDir: string, scope: MemoryScope, id: string): string {
  return join(getPendingDir(configDir), scope, `${id}.pending`);
}

// JSON, not a bespoke text format (unlike permissions.yaml): this file is the only reader/writer,
// nothing needs to hand-edit a staged write, and `content` can contain any character. Same
// atomicWriteFile.ts helper store.ts's applyWrite uses, for the same reason.
function writePendingFile(path: string, record: PendingWrite): void {
  atomicWriteFile(path, JSON.stringify(record, null, 2));
}

export function stagePendingWrite(
  req: MemoryWriteRequest,
  ctx: MemoryContext,
  now: Date,
): PendingWrite {
  const record: PendingWrite = {
    id: randomBytes(6).toString("hex"),
    stagedAt: now.toISOString(),
    scope: req.scope,
    action: req.action,
    target: req.target,
    content: req.content,
    reason: req.reason,
    durable: req.durable,
    // Stores projectKey(worktree), not the hash token: a hash cannot be reversed, and
    // decideMemoryCommand's /memory pending row needs a readable project name (basename) while
    // approvePending needs the token — both derive from this one stored path.
    projectPath: req.scope === "memory-project" ? projectKey(ctx.worktree) : undefined,
    entryDate: now.toISOString().slice(0, 10),
  };
  writePendingFile(pendingPath(ctx.configDir, req.scope, record.id), record);
  return record;
}

function isPendingWrite(value: unknown): value is PendingWrite {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.stagedAt === "string" &&
    (v.scope === "user" || v.scope === "memory-global" || v.scope === "memory-project") &&
    (v.action === "add" || v.action === "replace" || v.action === "remove") &&
    typeof v.reason === "string" &&
    typeof v.durable === "boolean" &&
    typeof v.entryDate === "string" &&
    // A "memory-project" record with no non-empty projectPath is malformed, not merely
    // unusual: ctxForPending falls back to `worktree: p.projectPath ?? ""`, and an empty
    // worktree resolves to process.cwd() at approval time — a hand-edited or corrupted
    // .pending file missing this field would silently read/write into whatever directory seri
    // happens to be invoked from, rather than failing loudly.
    (v.scope !== "memory-project" ||
      (typeof v.projectPath === "string" && v.projectPath.length > 0))
  );
}

const SCOPES: MemoryScope[] = ["user", "memory-global", "memory-project"];

// A malformed/unreadable .pending file is skipped with an onWarning call, never fatal — the same
// degrade-never-fail policy permissions/store.ts's readStore applies, for the same reason: one bad
// file must not make /memory pending unusable.
export function listPending(
  configDir: string,
  onWarning?: (message: string) => void,
): PendingWrite[] {
  const results: PendingWrite[] = [];
  const root = getPendingDir(configDir);
  for (const scope of SCOPES) {
    const dir = join(root, scope);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".pending")) continue;
      const path = join(dir, file);
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!isPendingWrite(parsed)) {
          onWarning?.(`ignoring ${path}: not a valid staged write`);
          continue;
        }
        results.push(parsed);
      } catch {
        onWarning?.(`could not parse ${path}, so it was ignored`);
      }
    }
  }
  // Ordering comes from the parsed stagedAt, not the filename — the id is hex for
  // accept/prefix-resolution (below), not for time-sortability.
  results.sort((a, b) => a.stagedAt.localeCompare(b.stagedAt));
  return results;
}

const ID_REF_RE = /^[0-9a-f]{4,40}$/;

// "all" | an unambiguous id prefix of >= 4 hex chars, mirroring /restore <sha>'s own convention
// (cli.ts, /^[0-9a-f]{4,40}$/).
export function resolvePendingRef(configDir: string, ref: string): PendingWrite[] {
  const all = listPending(configDir);
  if (ref === "all") return all;
  if (!ID_REF_RE.test(ref)) return [];
  const matches = all.filter((p) => p.id.startsWith(ref));
  if (matches.length > 1) {
    throw new Error(`Ambiguous id "${ref}" — matches ${matches.length} staged writes.`);
  }
  return matches;
}

// projectPath already IS projectKey(worktree) (stagePendingWrite's own comment) — reused directly
// as the "worktree" a MemoryContext carries, which reproduces the identical file path/hash a
// context built from the real worktree would, without needing the real worktree string at all.
function ctxForPending(configDir: string, p: PendingWrite): MemoryContext {
  return { configDir, worktree: p.projectPath ?? "" };
}

// Same shape store.ts's own labelFor produces for a live MemoryFile ("myrepo/MEMORY.md", not just
// "MEMORY.md") — reconstructed here from p.projectPath rather than read off the live file's own
// path (which is always .../MEMORY.md, the project only ever appearing as a hash-token directory
// in between, per memoryFilePath), and never from the caller's own ambient worktree: a pending
// write can target a DIFFERENT project than whichever one the caller currently stands in, so
// showing the caller's worktree here would name the wrong project. stagePendingWrite's own
// comment on why projectPath, not the hash token, is what gets stored.
export function pendingLabel(p: PendingWrite): string {
  if (p.scope === "user") return "USER.md";
  if (p.scope === "memory-global") return "MEMORY.md";
  return `${basename(p.projectPath ?? "")}/MEMORY.md`;
}

function toRequest(p: PendingWrite): MemoryWriteRequest {
  return {
    scope: p.scope,
    action: p.action,
    target: p.target,
    content: p.content,
    reason: p.reason,
    durable: p.durable,
  };
}

const DIFF_CONTEXT = 2;

// Every write is line-scoped (store.ts's computeWrite), so the diff is exact-prefix/exact-suffix
// trim, not a general LCS — the algorithm the plan specifies rather than a diff dependency.
function diffLines(before: string, after: string): string[] {
  const beforeLines = before.length === 0 ? [] : before.split("\n");
  const afterLines = after.length === 0 ? [] : after.split("\n");

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: string[] = [];
  for (const line of beforeLines.slice(Math.max(0, prefix - DIFF_CONTEXT), prefix))
    out.push(`  ${line}`);
  for (const line of beforeLines.slice(prefix, beforeLines.length - suffix)) out.push(`- ${line}`);
  for (const line of afterLines.slice(prefix, afterLines.length - suffix)) out.push(`+ ${line}`);
  for (const line of afterLines.slice(
    afterLines.length - suffix,
    afterLines.length - suffix + DIFF_CONTEXT,
  )) {
    out.push(`  ${line}`);
  }
  return out;
}

// Re-runs computeWrite against the CURRENT live file, not the file as it was at stage time — so a
// diff shown right before /memory approve reflects what approving would actually do, including
// when another write landed on the same file since this one was staged.
export function diffPending(configDir: string, p: PendingWrite): { path: string; lines: string[] } {
  const ctx = ctxForPending(configDir, p);
  const file = loadMemoryFile(p.scope, ctx);
  const after = computeWrite(file, toRequest(p), p.entryDate);
  const label = pendingLabel(p);
  return {
    path: file.path,
    lines: [
      `Reason: ${p.reason}`,
      `Durable: ${p.durable ? "yes" : "no"}`,
      `--- ${label} (live, ${file.chars}/${file.cap} chars)`,
      `+++ ${label} (if approved, ${after.length}/${file.cap} chars)`,
      ...diffLines(file.text, after),
    ],
  };
}

// Re-runs computeWrite against the CURRENT live file (via applyWrite), not the staged snapshot —
// this is the gap two independently-staged adds create: each passes the cap alone staged, but
// together may exceed it. A throw here propagates to the caller (memory/commands.ts) and leaves
// this write's .pending file in place, so the model or the human can consolidate and retry.
export function approvePending(configDir: string, p: PendingWrite): { path: string } {
  const ctx = ctxForPending(configDir, p);
  const result = applyWrite(toRequest(p), ctx, p.entryDate);
  unlinkSync(pendingPath(configDir, p.scope, p.id));
  return { path: result.path };
}

export function rejectPending(configDir: string, p: PendingWrite): void {
  unlinkSync(pendingPath(configDir, p.scope, p.id));
}
