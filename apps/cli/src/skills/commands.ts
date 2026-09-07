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

  previewed?: Map<string, string>;
};

const ID_ARG_RE = /^(all|[0-9a-f]{4,40})$/;



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


export function skillsPanelRows(deps: SkillsCommandDeps, skills: SkillRegistry): SkillsPanelRow[] {
  return [...skills.values()].map((skill) => ({
    name: skill.name,
    description: skill.description,
    scope: skill.source === "project" ? "project" : "global",


    where: skill.source === "project" ? relative(deps.worktree, skill.filePath) : skill.filePath,
    author: skill.author,
    modelInvocable: skill.modelInvocable,
  }));
}



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


        deps.previewed?.set(p.id, liveSkillFile(p));
        return diffPendingSkill(p).lines;
      }),
    };
  }

  if (sub === "approve" && rest.length === 1) {
    return {
      lines: forEachMatch(deps.configDir, rest[0] as string, "approve", false, (p) => {



        const { path } = approvePendingSkill(deps.configDir, p, deps.previewed?.get(p.id));



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
