import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { checkPermission } from "../../src/gate/gate";
import { createToolDefinitions } from "../../src/provider/tools";
import { loadSkillRegistry, type SkillRegistry } from "../../src/skills/registry";
import { SKILL_TOOL_NAME, withSkills } from "../../src/skills/tool";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function load(files: Record<string, string>): { skills: SkillRegistry; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "seri-skilltool-"));
  roots.push(root);
  const worktree = join(root, "project");
  const configDir = join(root, "profile");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return {
    skills: loadSkillRegistry({ worktree, configDir, onWarning: () => {} }),
    worktree,
  };
}

const REVIEWER = `---
name: reviewer
description: Reviews a diff.
---

Review this: $ARGUMENTS
`;

const execOpts: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "test-call",
  messages: [],
  context: {},
};

function run(tools: ReturnType<typeof withSkills>, args: unknown): Promise<unknown> {
  const definition = tools[SKILL_TOOL_NAME] as {
    execute: (args: unknown, options: unknown) => Promise<unknown>;
  };
  return definition.execute(args, { toolCallId: "t", messages: [] });
}

describe("withSkills", () => {
  test("adds no tool at all when the session has no skills", () => {
    const { skills } = load({});
    expect(withSkills({}, skills)).toEqual({});
  });

  test("adds the tool once a model-visible skill exists", () => {
    const { skills } = load({ "project/.seri/skills/reviewer/SKILL.md": REVIEWER });
    expect(Object.keys(withSkills({}, skills))).toEqual([SKILL_TOOL_NAME]);
  });

  test("returns the skill's body with the caller's arguments substituted", async () => {
    const { skills, worktree } = load({ "project/.seri/skills/reviewer/SKILL.md": REVIEWER });
    const tools = withSkills({}, skills);
    expect(await run(tools, { name: "reviewer", arguments: "the auth diff" })).toBe(
      `Base directory for this skill: ${join(worktree, ".seri", "skills", "reviewer")}\n\nReview this: the auth diff`,
    );
  });

  test("omitted arguments substitute to empty rather than leaving the token", async () => {
    const { skills, worktree } = load({ "project/.seri/skills/reviewer/SKILL.md": REVIEWER });
    expect(await run(withSkills({}, skills), { name: "reviewer" })).toBe(
      `Base directory for this skill: ${join(worktree, ".seri", "skills", "reviewer")}\n\nReview this: `,
    );
  });

  test("a disable-model-invocation skill is not in the enum and is refused by name", async () => {
    const { skills } = load({
      "project/.seri/skills/manual/SKILL.md":
        "---\ndescription: Only the user may run this.\ndisable-model-invocation: true\n---\n\nsecret body\n",
    });

    expect(withSkills({}, skills)).toEqual({});

    const { skills: mixed } = load({
      "project/.seri/skills/reviewer/SKILL.md": REVIEWER,
      "project/.seri/skills/manual/SKILL.md":
        "---\ndescription: Only the user may run this.\ndisable-model-invocation: true\n---\n\nsecret body\n",
    });
    const tools = withSkills({}, mixed);
    const definition = tools[SKILL_TOOL_NAME] as { inputSchema: unknown };

    expect(JSON.stringify(definition.inputSchema)).toContain("reviewer");
    expect(JSON.stringify(definition.inputSchema)).not.toContain("manual");
    await expect(run(tools, { name: "manual" })).rejects.toThrow(/no skill named "manual"/);
  });

  test("a skill whose file went away mid-session reports why instead of returning nothing", async () => {
    const { skills, worktree } = load({ "project/.seri/skills/reviewer/SKILL.md": REVIEWER });
    const tools = withSkills({}, skills);
    rmSync(join(worktree, ".seri", "skills", "reviewer"), { recursive: true, force: true });
    await expect(run(tools, { name: "reviewer" })).rejects.toThrow(/could not load the "reviewer"/);
  });

  test("the permission gate allows it in every mode, including read-only", () => {
    for (const mode of ["read-only", "approve-each", "auto"] as const) {
      expect(checkPermission(SKILL_TOOL_NAME, mode)).toBe("allow");
    }
  });

  test("names the skill directory so a bundled reference is readable without search", async () => {
    const { skills, worktree } = load({
      "project/.seri/skills/probe/SKILL.md":
        "---\nname: probe\ndescription: Probe criteria.\n---\n\nSee references/guide.md\n",
      "project/.seri/skills/probe/references/guide.md": "GUIDE-MARKER-4471\n",
    });
    const text = String(await run(withSkills({}, skills), { name: "probe" }));
    const match = /^Base directory for this skill: (.+)\n\nSee references\/guide.md$/.exec(text);
    expect(match?.[1]).toBe(join(worktree, ".seri", "skills", "probe"));
    const baseDir = match?.[1] ?? "";
    const fileTools = createToolDefinitions(worktree);
    expect(
      await fileTools.read_file.execute?.(
        { path: join(baseDir, "references", "guide.md") },
        execOpts,
      ),
    ).toBe("GUIDE-MARKER-4471\n");
    expect(() => fileTools.read_file.execute?.({ path: "references/guide.md" }, execOpts)).toThrow(
      /ENOENT/,
    );
  });
});
