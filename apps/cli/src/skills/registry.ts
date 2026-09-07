import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { commandByName } from "../cli/commandCatalog";
import { SKILLS_DIRNAME } from "../config/paths";
import { messageOf } from "../errors";
import { extensionScopes } from "../extensions/discovery";
import { isRoutableRole } from "../subagents/routes";
import { parseSkillFile, type SkillSpec, skillBodyOf } from "./skillFile";

export type { SkillSpec } from "./skillFile";


export type SkillRegistry = ReadonlyMap<string, SkillSpec>;

export const SKILL_FILENAME = "SKILL.md";





function skillFilesIn(dir: string, onWarning: (message: string) => void): readonly string[] {
  try {
    return readdirSync(dir)
      .sort()
      .map((entry) => join(dir, entry, SKILL_FILENAME))
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {



          return false;
        }
      });
  } catch (err) {
    onWarning(`could not read the skills directory ${dir}: ${messageOf(err)}`);
    return [];
  }
}


export function loadSkillRegistry(opts: {
  worktree: string;
  configDir: string;
  onWarning: (message: string) => void;
}): SkillRegistry {
  const skills = new Map<string, SkillSpec>();
  const scopes = extensionScopes({
    worktree: opts.worktree,
    configDir: opts.configDir,
    dirname: SKILLS_DIRNAME,
  });





  const isReserved = (name: string): boolean =>
    isRoutableRole(name) || commandByName(`/${name}`) !== undefined;

  for (const scope of scopes) {
    if (!existsSync(scope.dir)) continue;
    const loaded: string[] = [];
    for (const filePath of skillFilesIn(scope.dir, opts.onWarning)) {
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch (err) {
        opts.onWarning(`could not read the skill file ${filePath}: ${messageOf(err)}`);
        continue;
      }
      const outcome = parseSkillFile({ filePath, text, source: scope.source, isReserved });
      if (outcome.kind === "skipped") {
        opts.onWarning(outcome.warning);
        continue;
      }
      for (const warning of outcome.warnings) opts.onWarning(warning);




      const previous = skills.get(outcome.spec.name);
      if (previous?.source === scope.source) {
        opts.onWarning(
          `skill files ${previous.filePath} and ${filePath} both name "${outcome.spec.name}"; the later one wins`,
        );
      }
      skills.set(outcome.spec.name, outcome.spec);
      loaded.push(outcome.spec.name);
    }



    if (loaded.length > 0) opts.onWarning(`skills from ${scope.dir}: ${loaded.join(", ")}`);
  }
  return skills;
}


export function readSkillBody(spec: SkillSpec): string {
  const body = skillBodyOf(readFileSync(spec.filePath, "utf8"));
  if (body.length === 0) {
    throw new Error(`skill "${spec.name}" (${spec.filePath}) has no body below its frontmatter`);
  }
  return body;
}









const SUBSTITUTION = /\$(ARGUMENTS|\d)/g;

export function substituteSkillArgs(body: string, argumentText: string): string {
  const positionals = argumentText.split(/\s+/).filter((part) => part.length > 0);
  return body.replace(SUBSTITUTION, (_match, token: string) =>
    token === "ARGUMENTS" ? argumentText : (positionals[Number(token)] ?? ""),
  );
}


export function modelVisibleSkills(
  skills: SkillRegistry | readonly SkillSpec[],
): readonly SkillSpec[] {
  const all: readonly SkillSpec[] = Array.isArray(skills) ? skills : [...skills.values()];
  return all.filter((skill) => skill.modelInvocable && skill.description.length > 0);
}


export function renderSkillsTier(skills: readonly SkillSpec[]): string {
  const listed = modelVisibleSkills(skills);
  if (listed.length === 0) return "";
  return [
    "# Skills",
    "Named procedures this project defines. Each is a set of instructions you can load on demand " +
      "with the `skill` tool; the instructions themselves are not in this prompt until you do. " +
      "Load one when its description matches the task at hand.",
    "",


    ...listed.map(
      (skill) =>
        `- ${skill.name}${skill.argumentHint === undefined ? "" : ` ${skill.argumentHint}`}: ${skill.description}`,
    ),
  ].join("\n");
}
