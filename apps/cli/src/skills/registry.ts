import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { commandByName } from "../cli/commandCatalog";
import { SKILLS_DIRNAME } from "../config/paths";
import { messageOf } from "../errors";
import { extensionScopes } from "../extensions/discovery";
import { isRoutableRole } from "../subagents/routes";
import { parseSkillFile, type SkillSpec, skillBodyOf } from "./skillFile";

export type { SkillSpec } from "./skillFile";

/** Insertion order is precedence order: global, then project. A later `set` shadows an earlier one,
 *  so "project beats global" is structural rather than a conditional. */
export type SkillRegistry = ReadonlyMap<string, SkillSpec>;

export const SKILL_FILENAME = "SKILL.md";

// One directory per skill, and the name comes from the directory — so this lists directories, not
// files, which is the one structural difference from agentFilesIn (subagents/registry.ts). Sorted,
// so two directories resolving to the same name resolve the same way on every platform and every
// filesystem rather than by readdir order.
function skillFilesIn(dir: string, onWarning: (message: string) => void): readonly string[] {
  try {
    return readdirSync(dir)
      .sort()
      .map((entry) => join(dir, entry, SKILL_FILENAME))
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          // A directory with no SKILL.md is not an error worth a line: `.seri/skills/` is a place
          // people keep notes and templates next to their skills, and warning on every one of them
          // would make the real warnings unreadable.
          return false;
        }
      });
  } catch (err) {
    onWarning(`could not read the skills directory ${dir}: ${messageOf(err)}`);
    return [];
  }
}

/**
 * The profile root's `skills/`, then the project's `.seri/skills/`, into one Map in that order.
 * Total: every failure below is a warning, never a throw, because session start must not fail over
 * a skill file.
 *
 * No catalog and no agent registry are consulted, deliberately — that is what lets this run BEFORE
 * loadOrCreateSession (runtime/prepare.ts), which is where the skill listing has to be in hand
 * because buildSystemPrompt freezes the context tier there. A name shared with a user-defined agent
 * is therefore not refused here; it is reported once by prepareSession, after both registries exist,
 * and the shipped `/name` precedence (agents first) stands.
 */
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

  // A slash command's name and a routing target's name are both refused, the same two reservations
  // loadAgentRegistry applies. Built-in agent names are covered by isRoutableRole. A name a
  // previously loaded skill took is NOT reserved — the later `set` wins, which is how a project
  // skill shadows a global one.
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
      // A project skill shadowing a global one is the documented precedence and stays silent. Two
      // directories in the SAME scope resolving to one name is an authoring mistake — one
      // definition silently vanishes — and it is the only misload here that would otherwise say
      // nothing.
      const previous = skills.get(outcome.spec.name);
      if (previous?.source === scope.source) {
        opts.onWarning(
          `skill files ${previous.filePath} and ${filePath} both name "${outcome.spec.name}"; the later one wins`,
        );
      }
      skills.set(outcome.spec.name, outcome.spec);
      loaded.push(outcome.spec.name);
    }
    // One line per scope that produced something, so a session says which skills it actually took
    // and from where — the same visibility loadAgentRegistry prints, and for the same reason: a
    // skill that silently stopped loading looks exactly like one still there.
    if (loaded.length > 0) opts.onWarning(`skills from ${scope.dir}: ${loaded.join(", ")}`);
  }
  return skills;
}

/**
 * The body, read at the moment the skill fires and never before. This is the other half of the
 * progressive-disclosure contract SkillSpec's missing `body` field states: session start pays for
 * a name and a description, and only an actual invocation pays for the file.
 *
 * Throws on an unreadable file. Both call sites want that — the skill tool turns it into a tool
 * error the model reads in the same turn, and `/name` turns it into a command-error — because a
 * skill the user asked for and that silently did nothing is worse than one that says why.
 */
export function readSkillBody(spec: SkillSpec): string {
  const body = skillBodyOf(readFileSync(spec.filePath, "utf8"));
  if (body.length === 0) {
    throw new Error(`skill "${spec.name}" (${spec.filePath}) has no body below its frontmatter`);
  }
  return body;
}

// $ARGUMENTS is the whole argument string; $0..$9 are the whitespace-split positionals. Both
// conventions are in live use in the format this borrows from, so both are honoured rather than
// one being picked and the other silently doing nothing. A positional the user did not supply
// substitutes to "" — a skill body written for three arguments and invoked with one should read as
// a task with two blanks, not as a task containing the literal text "$2".
//
// One pass, not two: substituting $ARGUMENTS first and then scanning again for $0 would re-scan the
// user's own text, so an argument that happened to contain "$1" would itself be substituted.
const SUBSTITUTION = /\$(ARGUMENTS|\d)/g;

export function substituteSkillArgs(body: string, argumentText: string): string {
  const positionals = argumentText.split(/\s+/).filter((part) => part.length > 0);
  return body.replace(SUBSTITUTION, (_match, token: string) =>
    token === "ARGUMENTS" ? argumentText : (positionals[Number(token)] ?? ""),
  );
}

/**
 * The skills the model is allowed to know about: model-invocable, and carrying a description to
 * select on. One predicate, used by both model-facing surfaces — the prompt listing below and the
 * skill tool's own enum — so a skill can never be advertised in one and refused by the other.
 */
export function modelVisibleSkills(
  skills: SkillRegistry | readonly SkillSpec[],
): readonly SkillSpec[] {
  const all: readonly SkillSpec[] = Array.isArray(skills) ? skills : [...skills.values()];
  return all.filter((skill) => skill.modelInvocable && skill.description.length > 0);
}

/**
 * The context tier's skill listing: names and descriptions only, never a body. Empty string when
 * nothing is model-invocable, so joinTiers' own filter(Boolean) drops it and a session with no
 * skills renders byte-identically to one from before this existed.
 *
 * A `disable-model-invocation` skill is left out entirely rather than listed as unavailable —
 * telling the model about a skill it may not call is a per-turn cost with no payoff, and the
 * omission is the first of that flag's two independent guards (the skill tool's own enum is the
 * second).
 */
export function renderSkillsTier(skills: readonly SkillSpec[]): string {
  const listed = modelVisibleSkills(skills);
  if (listed.length === 0) return "";
  return [
    "# Skills",
    "Named procedures this project defines. Each is a set of instructions you can load on demand " +
      "with the `skill` tool; the instructions themselves are not in this prompt until you do. " +
      "Load one when its description matches the task at hand.",
    "",
    // The argument hint rides the same line as the description rather than being restated in the
    // tool's own schema, so a skill's calling shape is written in exactly one place.
    ...listed.map(
      (skill) =>
        `- ${skill.name}${skill.argumentHint === undefined ? "" : ` ${skill.argumentHint}`}: ${skill.description}`,
    ),
  ].join("\n");
}
