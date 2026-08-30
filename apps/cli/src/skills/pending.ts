import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { getPendingDir, SKILLS_DIRNAME } from "../config/paths";
import { diffLines } from "../diffLines";
import { SKILL_FILENAME } from "./registry";
import { skillBodyOf } from "./skillFile";

/**
 * One skill the archivist proposed, waiting on a human. Its own type and its own queue directory
 * rather than a fourth `MemoryScope`: a memory write is one line into one capped file addressed by
 * a substring, and a skill is a whole multi-line file addressed by a path. Widening `PendingWrite`
 * to carry both would mean `toRequest` handing `computeWrite` a scope it cannot serve, which the
 * type system already refuses.
 */
export type PendingSkill = {
  id: string; // 12 hex chars, the same shape and the same prefix-matching rules a memory write has
  stagedAt: string;
  name: string;
  description: string;
  body: string;
  reason: string; // provenance: which turn made this look worth keeping
  durable: boolean; // provenance: a lasting procedure, or something this session happened to do
  // The absolute worktree the approved file lands in. Stored rather than taken from the approving
  // session's own cwd, so a skill staged in one repo cannot be approved into a different one just
  // because that is where the user happened to be standing.
  //
  // resolve(), deliberately NOT projectKey(): that function case-folds on win32/darwin because it
  // builds an identity KEY, and a folded string is the wrong thing to write a file at — the write
  // still lands correctly on those case-insensitive filesystems, but every path this record shows a
  // human afterwards would be lowercased.
  worktree: string;
};

const PENDING_SUFFIX = ".pending";

export function pendingSkillDir(configDir: string): string {
  return join(getPendingDir(configDir), SKILLS_DIRNAME);
}

export function pendingSkillPath(configDir: string, id: string): string {
  return join(pendingSkillDir(configDir), `${id}${PENDING_SUFFIX}`);
}

/**
 * Where an approved skill lands: the PROJECT scope of the repository it was learned in.
 *
 * Not the profile root, deliberately. A procedure learned from work in one repository is about that
 * repository, and putting it in the global scope would steer every other project the user opens.
 * The cost is that the approved file sits inside the user's own tree, where their VCS can see it —
 * which is the point of the approval gate and of the `author` marker the file carries, not an
 * oversight.
 */
export function approvedSkillPath(worktree: string, name: string): string {
  return join(worktree, ".seri", SKILLS_DIRNAME, name, SKILL_FILENAME);
}

// The file as it will be written. Frontmatter first, then the body — the same shape parseSkillFile
// reads, so a staged skill is a skill the loader can take the moment it is approved. `author` is
// what makes it visibly the archivist's rather than the user's, and `reason` travels into the file
// alongside it: unlike a memory entry, whose provenance is discarded once applied, a skill is a
// standing artifact and a reader six months later still deserves to know why it exists.
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
    // Empty is malformed, not merely unusual: approvePendingSkill joins this into the target path,
    // and an empty one would write into whatever directory the approving process is standing in.
    typeof v.worktree === "string" &&
    v.worktree.length > 0
  );
}

// A malformed or unreadable record is skipped with a warning, never fatal — one bad file must not
// make the whole queue unreviewable, the same degrade-never-fail policy every other store here has.
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

// "all" or an unambiguous id prefix of at least 4 hex characters, the convention /restore and
// /memory both already use.
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

/**
 * The preview, rendered against the file as it stands RIGHT NOW rather than as it stood when the
 * write was staged — so what the human reads is what approving would actually do, including when a
 * skill of the same name has appeared since.
 */
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

// CRLF folded to LF before any compare or diff. A skill file edited in Notepad and one written by
// atomicWriteFile differ only in line endings, and without this the approve guard below would
// refuse every Windows-edited file as "changed".
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** The live file as diffPendingSkill reads it, so a caller can hand it back to approvePendingSkill
 *  as the "this is what I showed the human" token. */
export function liveSkillFile(p: PendingSkill): string {
  const path = approvedSkillPath(p.worktree, p.name);
  return existsSync(path) ? normalizeEol(readFileSync(path, "utf8")) : "";
}

export function approvePendingSkill(
  configDir: string,
  p: PendingSkill,
  /** What the human was shown, when they were shown anything. Absent means "approve whatever is
   *  there", which is all a caller with no preview behind it can honestly mean. */
  previewedAgainst?: string,
): { path: string } {
  const path = approvedSkillPath(p.worktree, p.name);
  // A staged skill can sit in the queue for days, and `/skills approve all` renders no diff at all.
  // Overwriting a file the human edited in between would destroy their work silently, and this file
  // is theirs — no checkpoint covers it. Refusing leaves the staged record in place, which is what
  // makes the retry (diff, look, approve) possible.
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

/** Exported for the write tool's own duplicate check: a name already on disk is a replace, and the
 *  archivist is told so rather than finding out at approval time. */
export function existingSkillBody(worktree: string, name: string): string | undefined {
  const path = approvedSkillPath(worktree, name);
  return existsSync(path) ? skillBodyOf(readFileSync(path, "utf8")) : undefined;
}
