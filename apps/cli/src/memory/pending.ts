import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { getPendingDir } from "../config/paths";
import { diffLines } from "../diffLines";
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
  id: string;
  stagedAt: string;
  scope: MemoryScope;
  action: "add" | "replace" | "remove";
  target?: string;
  content?: string;
  reason: string;
  durable: boolean;
  projectPath?: string;
  entryDate: string;
};

export function pendingPath(configDir: string, scope: MemoryScope, id: string): string {
  return join(getPendingDir(configDir), scope, `${id}.pending`);
}




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





    (v.scope !== "memory-project" ||
      (typeof v.projectPath === "string" && v.projectPath.length > 0))
  );
}

const SCOPES: MemoryScope[] = ["user", "memory-global", "memory-project"];




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


  results.sort((a, b) => a.stagedAt.localeCompare(b.stagedAt));
  return results;
}

const ID_REF_RE = /^[0-9a-f]{4,40}$/;



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




function ctxForPending(configDir: string, p: PendingWrite): MemoryContext {
  return { configDir, worktree: p.projectPath ?? "" };
}








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





export function approvePending(configDir: string, p: PendingWrite): { path: string } {
  const ctx = ctxForPending(configDir, p);
  const result = applyWrite(toRequest(p), ctx, p.entryDate);
  unlinkSync(pendingPath(configDir, p.scope, p.id));
  return { path: result.path };
}

export function rejectPending(configDir: string, p: PendingWrite): void {
  unlinkSync(pendingPath(configDir, p.scope, p.id));
}
