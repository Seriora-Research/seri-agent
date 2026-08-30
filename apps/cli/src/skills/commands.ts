import { relative } from "node:path";
import { messageOf } from "../errors";
import { truncate } from "../truncate";
import type { SkillsPanelRow } from "../tui/util/format";
import {
  approvePendingSkill,
  diffPendingSkill,
  listPendingSkills,
  type PendingSkill,
  rejectPendingSkill,
  resolvePendingSkillRef,
} from "./pending";
import { loadSkillRegistry } from "./registry";

export type SkillsCommandDeps = { configDir: string; worktree: string };

const ID_ARG_RE = /^(all|[0-9a-f]{4,40})$/;

// The gate cli.ts runs before decideSkillsCommand is ever called, kept here so it can be tested
// against the exact strings a user types — the same split /memory's own accepts predicate uses.
export function skillsCommandAccepts(args: string[]): boolean {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "list" || sub === "pending") return rest.length === 0;
  if (sub === "diff" || sub === "approve" || sub === "reject")
    return rest.length === 1 && ID_ARG_RE.test(rest[0] ?? "");
  return false;
}

function summaryLine(p: PendingSkill): string {
  return `${p.id}  ${p.name}  ${truncate(p.description, 70)}`;
}

// Shared by diff/approve/reject, the same shape /memory's own forEachMatch has and for the same
// reason: one entry's throw in an "all" batch must not discard the lines already collected for the
// entries before it, or the user cannot tell which of N actually happened.
function forEachMatch(
  configDir: string,
  ref: string,
  verb: string,
  separateEntries: boolean,
  act: (p: PendingSkill) => string[],
): string[] {
  let matches: PendingSkill[];
  try {
    matches = resolvePendingSkillRef(configDir, ref);
  } catch (err) {
    return [messageOf(err)];
  }
  if (matches.length === 0) return [`No staged skill matches "${ref}".`];
  const lines: string[] = [];
  for (const p of matches) {
    try {
      lines.push(...act(p));
    } catch (err) {
      lines.push(`Could not ${verb} ${p.id}: ${messageOf(err)}`);
    }
    if (separateEntries) lines.push("");
  }
  return lines;
}

/**
 * The panel's rows, resolved from the session's own discovery walk — so it shows this project's
 * skills and this profile's global ones, and cannot show another project's: the walk has no way to
 * reach one.
 */
export function skillsPanelRows(deps: SkillsCommandDeps): SkillsPanelRow[] {
  const skills = loadSkillRegistry({
    worktree: deps.worktree,
    configDir: deps.configDir,
    onWarning: () => {},
  });
  return [...skills.values()].map((skill) => ({
    name: skill.name,
    description: skill.description,
    scope: skill.source === "project" ? "project" : "global",
    // Worktree-relative for a project skill, because that is how someone would open it from here.
    // Absolute for a global one, which lives outside the tree and has no useful relative form.
    where: skill.source === "project" ? relative(deps.worktree, skill.filePath) : skill.filePath,
    author: skill.author,
    modelInvocable: skill.modelInvocable,
  }));
}

// The review half. The listing half is the panel above — `/skills` with no arguments opens it, so
// nothing here handles a bare invocation.
export function decideSkillsCommand(args: string[], deps: SkillsCommandDeps): { lines: string[] } {
  const [sub, ...rest] = args;

  if (sub === "pending") {
    const pending = listPendingSkills(deps.configDir);
    if (pending.length === 0) return { lines: ["No staged skills."] };
    return { lines: pending.map(summaryLine) };
  }

  if (sub === "diff" && rest.length === 1) {
    return {
      lines: forEachMatch(deps.configDir, rest[0] as string, "diff", true, (p) => {
        return diffPendingSkill(p).lines;
      }),
    };
  }

  if (sub === "approve" && rest.length === 1) {
    return {
      lines: forEachMatch(deps.configDir, rest[0] as string, "approve", false, (p) => {
        const { path } = approvePendingSkill(deps.configDir, p);
        // "next session", not "now": the registry is frozen per session (prepare.ts), so a skill
        // approved mid-session is not loadable until the next one or a /clear. Saying otherwise
        // would send the user off to type /name for something that is not there yet.
        return [`Approved ${p.id}: wrote ${path}. It loads in the next session, or after /clear.`];
      }),
    };
  }

  if (sub === "reject" && rest.length === 1) {
    return {
      lines: forEachMatch(deps.configDir, rest[0] as string, "reject", false, (p) => {
        rejectPendingSkill(deps.configDir, p);
        return [`Rejected ${p.id}.`];
      }),
    };
  }

  return {
    lines: ["Usage: /skills [list] | pending | diff <id|all> | approve <id|all> | reject <id|all>"],
  };
}
