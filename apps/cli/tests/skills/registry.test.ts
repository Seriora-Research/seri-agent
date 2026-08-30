import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSystemPrompt } from "../../src/agents/systemPrompt";
import {
  loadSkillRegistry,
  modelVisibleSkills,
  readSkillBody,
  renderSkillsTier,
  type SkillRegistry,
  substituteSkillArgs,
} from "../../src/skills/registry";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

// The worktree sits several directories below the tree root so the upward walk has something to
// walk, and the profile root is a sibling of the project rather than an ancestor of it — the same
// fixture shape the agent registry's own tests use.
function makeTree(files: Record<string, string>): { worktree: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), "seri-skills-"));
  roots.push(root);
  const worktree = join(root, "project", "packages", "cli");
  const configDir = join(root, "profile");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return { worktree, configDir };
}

function load(files: Record<string, string>): { skills: SkillRegistry; warnings: string[] } {
  const { worktree, configDir } = makeTree(files);
  const warnings: string[] = [];
  const skills = loadSkillRegistry({
    worktree,
    configDir,
    onWarning: (message) => warnings.push(message),
  });
  return { skills, warnings };
}

const SIMPLE = `---
name: reviewer
description: Reviews a diff and reports findings.
---

Review the diff for: $ARGUMENTS
`;

describe("loadSkillRegistry", () => {
  test("no skills directory anywhere loads nothing and warns about nothing", () => {
    const { skills, warnings } = load({});
    expect(skills.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("finds a project skill by walking up from the worktree", () => {
    const { skills } = load({ "project/.seri/skills/reviewer/SKILL.md": SIMPLE });
    expect([...skills.keys()]).toEqual(["reviewer"]);
    expect(skills.get("reviewer")?.source).toBe("project");
  });

  test("finds a global skill under the profile root", () => {
    const { skills } = load({ "profile/skills/reviewer/SKILL.md": SIMPLE });
    expect(skills.get("reviewer")?.source).toBe("user");
  });

  test("a project skill beats a global one of the same name", () => {
    const { skills } = load({
      "profile/skills/reviewer/SKILL.md": SIMPLE,
      "project/.seri/skills/reviewer/SKILL.md": SIMPLE.replace(
        "Reviews a diff and reports findings.",
        "The project's own reviewer.",
      ),
    });
    expect(skills.size).toBe(1);
    expect(skills.get("reviewer")?.description).toBe("The project's own reviewer.");
    expect(skills.get("reviewer")?.source).toBe("project");
  });

  test("the name comes from the directory when the frontmatter omits it", () => {
    const { skills } = load({
      "project/.seri/skills/verify-gate/SKILL.md":
        "---\ndescription: Runs the checks.\n---\n\nRun them.\n",
    });
    expect([...skills.keys()]).toEqual(["verify-gate"]);
  });

  test("a directory with no SKILL.md is ignored in silence", () => {
    const { skills, warnings } = load({
      "project/.seri/skills/notes/README.md": "just notes",
      "project/.seri/skills/reviewer/SKILL.md": SIMPLE,
    });
    expect([...skills.keys()]).toEqual(["reviewer"]);
    expect(warnings.filter((w) => w.includes("notes"))).toEqual([]);
  });

  // Negative control: a broken file must not take session start down with it, and the warning has
  // to name the file or the user cannot find what to fix.
  test("a file with no frontmatter is skipped with a warning naming it", () => {
    const { skills, warnings } = load({
      "project/.seri/skills/loose/SKILL.md": "# Just a heading, no frontmatter\n",
      "project/.seri/skills/reviewer/SKILL.md": SIMPLE,
    });
    expect([...skills.keys()]).toEqual(["reviewer"]);
    expect(warnings.some((w) => w.includes("loose") && w.includes("no YAML frontmatter"))).toBe(
      true,
    );
  });

  test("a file whose frontmatter is not valid YAML is skipped with a warning naming it", () => {
    const { skills, warnings } = load({
      "project/.seri/skills/broken/SKILL.md": "---\nname: [unclosed\n---\n\nbody\n",
    });
    expect(skills.size).toBe(0);
    expect(warnings.some((w) => w.includes("broken") && w.includes("not valid YAML"))).toBe(true);
  });

  // Negative control: a skill free to call itself /mode would shadow a shipped command.
  test("a name that collides with a slash command is refused", () => {
    const { skills, warnings } = load({
      "project/.seri/skills/mode/SKILL.md": "---\ndescription: Hijacks /mode.\n---\n\nbody\n",
    });
    expect(skills.size).toBe(0);
    expect(warnings.some((w) => w.includes("already taken"))).toBe(true);
  });

  test("a name that collides with a built-in agent role is refused", () => {
    const { skills } = load({
      "project/.seri/skills/explore/SKILL.md":
        "---\ndescription: Shadows the explore role.\n---\n\nbody\n",
    });
    expect(skills.size).toBe(0);
  });

  test("two directories in one scope naming the same skill warn that the later wins", () => {
    const { skills, warnings } = load({
      "project/.seri/skills/a/SKILL.md": "---\nname: dup\ndescription: First.\n---\n\nbody\n",
      "project/.seri/skills/b/SKILL.md": "---\nname: dup\ndescription: Second.\n---\n\nbody\n",
    });
    expect(skills.get("dup")?.description).toBe("Second.");
    expect(warnings.some((w) => w.includes("both name") && w.includes("dup"))).toBe(true);
  });

  test("a loaded scope reports which skills it took and from where", () => {
    const { warnings } = load({ "project/.seri/skills/reviewer/SKILL.md": SIMPLE });
    expect(warnings.some((w) => w.startsWith("skills from ") && w.endsWith(": reviewer"))).toBe(
      true,
    );
  });
});

describe("readSkillBody", () => {
  test("returns the text below the frontmatter and nothing above it", () => {
    const { skills } = load({ "project/.seri/skills/reviewer/SKILL.md": SIMPLE });
    const body = readSkillBody(skills.get("reviewer") as never);
    expect(body).toBe("Review the diff for: $ARGUMENTS");
    expect(body).not.toContain("description:");
  });

  test("throws when the file has a fence and nothing under it", () => {
    const { skills } = load({
      "project/.seri/skills/empty/SKILL.md": "---\ndescription: Nothing follows.\n---\n",
    });
    expect(() => readSkillBody(skills.get("empty") as never)).toThrow(/no body/);
  });
});

describe("substituteSkillArgs", () => {
  test("$ARGUMENTS is the whole argument string", () => {
    expect(substituteSkillArgs("Do: $ARGUMENTS", "fix the login bug")).toBe(
      "Do: fix the login bug",
    );
  });

  test("$0/$1 are the whitespace-split positionals", () => {
    expect(substituteSkillArgs("mode=$0 task=$1", "bugfix login")).toBe("mode=bugfix task=login");
  });

  test("a positional the caller did not supply becomes empty, not the literal token", () => {
    expect(substituteSkillArgs("a=$0 b=$1", "only")).toBe("a=only b=");
  });

  // One pass, not two: substituting $ARGUMENTS and then re-scanning would substitute a token that
  // came from the user's own text.
  test("a token inside the substituted text is not itself substituted", () => {
    expect(substituteSkillArgs("$ARGUMENTS", "literally $1 dollars")).toBe("literally $1 dollars");
  });
});

describe("renderSkillsTier and the context tier", () => {
  test("lists name and description, and never the body", () => {
    const { skills } = load({ "project/.seri/skills/reviewer/SKILL.md": SIMPLE });
    const tier = renderSkillsTier([...skills.values()]);
    expect(tier).toContain("reviewer: Reviews a diff and reports findings.");
    expect(tier).not.toContain("Review the diff for");
  });

  test("includes the argument hint on the skill's own line", () => {
    const { skills } = load({
      "project/.seri/skills/bugfix/SKILL.md":
        '---\ndescription: Fixes a bug.\nargument-hint: "<bug description>"\n---\n\nbody\n',
    });
    expect(renderSkillsTier([...skills.values()])).toContain(
      "bugfix <bug description>: Fixes a bug.",
    );
  });

  test("derives a hint from the arguments list when argument-hint is absent", () => {
    const { skills } = load({
      "project/.seri/skills/loop/SKILL.md":
        "---\ndescription: Runs a loop.\narguments: [mode, prompt]\n---\n\nbody\n",
    });
    expect(skills.get("loop")?.argumentHint).toBe("<mode> <prompt>");
  });

  // Negative control for the flag's first of two guards. If this passes with the flag honoured
  // nowhere, the assertion is vacuous — it is red when `modelInvocable` is ignored.
  test("a disable-model-invocation skill is absent from the listing entirely", () => {
    const { skills } = load({
      "project/.seri/skills/manual/SKILL.md":
        "---\ndescription: Only the user may run this.\ndisable-model-invocation: true\n---\n\nbody\n",
    });
    expect(skills.get("manual")).toBeDefined();
    expect(skills.get("manual")?.modelInvocable).toBe(false);
    expect(modelVisibleSkills(skills)).toEqual([]);
    expect(renderSkillsTier([...skills.values()])).toBe("");
  });

  test("a skill with no description is not advertised to the model", () => {
    const { skills, warnings } = load({
      "project/.seri/skills/nameless/SKILL.md": "---\nname: nameless\n---\n\nbody\n",
    });
    expect(skills.get("nameless")).toBeDefined();
    expect(modelVisibleSkills(skills)).toEqual([]);
    expect(warnings.some((w) => w.includes("no description"))).toBe(true);
  });

  test("empty when nothing is model-visible, so the prompt is unchanged from having no skills", () => {
    expect(renderSkillsTier([])).toBe("");
    expect(buildSystemPrompt({ agentsContent: "PROJECT", skills: [], rules: [] })).toBe(
      buildSystemPrompt({ agentsContent: "PROJECT", skills: [], rules: [] }),
    );
    expect(buildSystemPrompt({ agentsContent: "PROJECT", skills: [], rules: [] })).not.toContain("# Skills");
  });

  // The load contract, asserted at the surface that actually matters: the body is not in the
  // string handed to the provider.
  test("the assembled system prompt carries the metadata and not the body", () => {
    const { skills } = load({ "project/.seri/skills/reviewer/SKILL.md": SIMPLE });
    const prompt = buildSystemPrompt({ agentsContent: "PROJECT", skills: [...skills.values()], rules: [] });
    expect(prompt).toContain("# Skills");
    expect(prompt).toContain("reviewer: Reviews a diff and reports findings.");
    expect(prompt).not.toContain("Review the diff for");
  });

  test("AGENTS.md still comes before the skill listing", () => {
    const { skills } = load({ "project/.seri/skills/reviewer/SKILL.md": SIMPLE });
    const prompt = buildSystemPrompt({
      agentsContent: "PROJECT-CONTRACT",
      skills: [...skills.values()], rules: [] });
    expect(prompt.indexOf("PROJECT-CONTRACT")).toBeLessThan(prompt.indexOf("# Skills"));
  });
});

describe("frontmatter seri does not act on", () => {
  test("allowed-tools and model are tolerated, ignored, and warned about by name", () => {
    const { skills, warnings } = load({
      "project/.seri/skills/gate/SKILL.md":
        "---\ndescription: Runs the checks.\nallowed-tools: Read, Bash\nmodel: inherit\n---\n\nbody\n",
    });
    expect(skills.get("gate")).toBeDefined();
    const warning = warnings.find((w) => w.includes("seri ignores"));
    expect(warning).toContain('"allowed-tools"');
    expect(warning).toContain('"model"');
  });

  test("an unknown key is tolerated in silence", () => {
    const { skills, warnings } = load({
      "project/.seri/skills/future/SKILL.md":
        "---\ndescription: From a later harness.\nsome-future-key: true\n---\n\nbody\n",
    });
    expect(skills.get("future")).toBeDefined();
    expect(warnings.some((w) => w.includes("some-future-key"))).toBe(false);
  });

  test("author: archivist is recorded, and anything else reads as human", () => {
    const { skills } = load({
      "project/.seri/skills/learned/SKILL.md":
        "---\ndescription: Written by the archivist.\nauthor: archivist\n---\n\nbody\n",
      "project/.seri/skills/typed/SKILL.md":
        "---\ndescription: Written by a person.\n---\n\nbody\n",
    });
    expect(skills.get("learned")?.author).toBe("archivist");
    expect(skills.get("typed")?.author).toBe("human");
  });
});
