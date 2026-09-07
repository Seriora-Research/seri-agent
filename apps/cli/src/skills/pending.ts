import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { getPendingDir, SKILLS_DIRNAME } from "../config/paths";
import { diffLines } from "../diffLines";
import { SKILL_FILENAME } from "./registry";
import { skillBodyOf } from "./skillFile";


export type PendingSkill = {
  id: string;
  stagedAt: string;
  name: string;
  description: string;
  body: string;
  reason: string;
  durable: boolean;








  worktree: string;
};

const PENDING_SUFFIX = ".pending";

export function pendingSkillDir(configDir: string): string {
  return join(getPendingDir(configDir), SKILLS_DIRNAME);
}

export function pendingSkillPath(configDir: string, id: string): string {
  return join(pendingSkillDir(configDir), `${id}${PENDING_SUFFIX}`);
}


export function approvedSkillPath(worktree: string, name: string): string {
  return join(worktree, ".seri", SKILLS_DIRNAME, name, SKILL_FILENAME);
}






export function renderSkillFile(p: PendingSkill): string {
  return [
    "---",
    `name: ${p.name}`,
    `description: ${JSON.stringify(p.description)}`,
    "author: archivist",
    `reason: ${JSON.stringify(p.reason)}`,
    `staged: ${p.stagedAt.slice(0, 10)}`,
    "---",
    "",
    p.body,
    "",
  ].join("\n");
}

export function stagePendingSkill(
  input: { name: string; description: string; body: string; reason: string; durable: boolean },
  ctx: { configDir: string; worktree: string },
  now: Date,
): PendingSkill {
  const record: PendingSkill = {
    id: randomBytes(6).toString("hex"),
    stagedAt: now.toISOString(),
    name: input.name,
    description: input.description,
    body: input.body,
    reason: input.reason,
    durable: input.durable,
    worktree: resolve(ctx.worktree),
  };
  atomicWriteFile(pendingSkillPath(ctx.configDir, record.id), JSON.stringify(record, null, 2));
  return record;
}

function isPendingSkill(value: unknown): value is PendingSkill {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.stagedAt === "string" &&
    typeof v.name === "string" &&
    typeof v.description === "string" &&
    typeof v.body === "string" &&
    typeof v.reason === "string" &&
    typeof v.durable === "boolean" &&


    typeof v.worktree === "string" &&
    v.worktree.length > 0
  );
}



export function listPendingSkills(
  configDir: string,
  onWarning?: (message: string) => void,
): PendingSkill[] {
  const dir = pendingSkillDir(configDir);
  if (!existsSync(dir)) return [];
  const results: PendingSkill[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(PENDING_SUFFIX)) continue;
    const path = join(dir, file);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!isPendingSkill(parsed)) {
        onWarning?.(`ignoring ${path}: not a valid staged skill`);
        continue;
      }
      results.push(parsed);
    } catch {
      onWarning?.(`could not parse ${path}, so it was ignored`);
    }
  }
  results.sort((a, b) => a.stagedAt.localeCompare(b.stagedAt));
  return results;
}

const ID_REF_RE = /^[0-9a-f]{4,40}$/;



export function resolvePendingSkillRef(configDir: string, ref: string): PendingSkill[] {
  const all = listPendingSkills(configDir);
  if (ref === "all") return all;
  if (!ID_REF_RE.test(ref)) return [];
  const matches = all.filter((p) => p.id.startsWith(ref));
  if (matches.length > 1) {
    throw new Error(`Ambiguous id "${ref}" — matches ${matches.length} staged skills.`);
  }
  return matches;
}


export function diffPendingSkill(p: PendingSkill): { path: string; lines: string[] } {
  const path = approvedSkillPath(p.worktree, p.name);
  const before = liveSkillFile(p);
  const after = renderSkillFile(p);
  return {
    path,
    lines: [
      `Reason: ${p.reason}`,
      `Durable: ${p.durable ? "yes" : "no"}`,
      `--- ${path}${before.length === 0 ? " (new file)" : " (live)"}`,
      `+++ ${path} (if approved)`,
      ...diffLines(before, after),
    ],
  };
}




function normalizeEol(text: string): string {
  // CRLF folded to LF: a skill edited in Notepad and one written by seri must compare equal.
  return text.replace(/\r\n/g, "\n");
}


export function liveSkillFile(p: PendingSkill): string {
  const path = approvedSkillPath(p.worktree, p.name);
  return existsSync(path) ? normalizeEol(readFileSync(path, "utf8")) : "";
}

export function approvePendingSkill(
  configDir: string,
  p: PendingSkill,

  previewedAgainst?: string,
): { path: string } {
  const path = approvedSkillPath(p.worktree, p.name);




  if (previewedAgainst !== undefined && liveSkillFile(p) !== previewedAgainst) {
    throw new Error(
      `${path} changed since it was previewed. Run /skills diff ${p.id} again to see the current file, then approve.`,
    );
  }
  atomicWriteFile(path, renderSkillFile(p));
  unlinkSync(pendingSkillPath(configDir, p.id));
  return { path };
}

export function rejectPendingSkill(configDir: string, p: PendingSkill): void {
  unlinkSync(pendingSkillPath(configDir, p.id));
}


export function existingSkillBody(worktree: string, name: string): string | undefined {
  const path = approvedSkillPath(worktree, name);
  return existsSync(path) ? skillBodyOf(readFileSync(path, "utf8")) : undefined;
}
