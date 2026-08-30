import { relative } from "node:path";
import { messageOf } from "../errors";
import { truncate } from "../truncate";
import type { SkillsPanelRow } from "../tui/util/format";
import {
  approvePendingSkill,
  diffPendingSkill,
  listPendingSkills,
  liveSkillFile,
  type PendingSkill,
  rejectPendingSkill,
  resolvePendingSkillRef,
} from "./pending";
import type { SkillRegistry } from "./registry";

export type SkillsCommandDeps = {
  configDir: string;
  worktree: string;
  /** Staged-skill id to the live file text at the moment `/skills diff` last rendered it. Owned by
   *  the session, so it survives across commands but not across runs — which is the right lifetime:
   *  "you looked at this a moment ago" is a claim only the running session can make. */
  previewed?: Map<string, string>;
};

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
 * The panel's rows, built from the registry the SESSION actually loaded — never a fresh disk read.
 *
 * The distinction is the whole point of the panel. `PreparedRun.skills` is frozen at session start
 * (and reloaded only by `/clear`), so a skill added or approved since then is not invocable yet. A
 * panel that re-read disk would list it anyway, and `/name` would answer "Unrecognized command" for
 * a row the user was just looking at. Showing what the session can actually run is more useful than
 * showing what is on disk, and `/skills approve` already says a new skill lands next session.
 *
 * It shows this project's skills and this profile's global ones, and cannot show another project's:
 * the discovery walk has no way to reach one.
 */
export function skillsPanelRows(deps: SkillsCommandDeps, skills: SkillRegistry): SkillsPanelRow[] {
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
        // Recorded as the diff is rendered, so a later approve can tell whether the file moved
        // under the human between looking and deciding.
        deps.previewed?.set(p.id, liveSkillFile(p));
        return diffPendingSkill(p).lines;
      }),
    };
  }

  if (sub === "approve" && rest.length === 1) {
    return {
      lines: forEachMatch(deps.configDir, rest[0] as string, "approve", false, (p) => {
        // Compared against the file as it stands now only when a diff was actually rendered this
        // session — otherwise there is nothing the human was shown for it to have changed from, and
        // demanding one would refuse every first-time approve.
        const { path } = approvePendingSkill(deps.configDir, p, deps.previewed?.get(p.id));
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
