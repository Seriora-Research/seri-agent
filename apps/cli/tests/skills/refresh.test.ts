import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { refreshPreparedSkills, type SkillRefreshTarget } from "../../src/skills/refresh";
import { loadSkillRegistry } from "../../src/skills/registry";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function writeSkill(root: string, relative: string, text: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function makeTarget(): {
  root: string;
  worktree: string;
  configDir: string;
  prepared: SkillRefreshTarget;
} {
  const root = mkdtempSync(join(tmpdir(), "seri-skill-refresh-"));
  roots.push(root);
  const worktree = join(root, "project");
  const configDir = join(root, "profile");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(worktree, "AGENTS.md"), "PROJECT-AGENTS");
  const prepared: SkillRefreshTarget = {
    session: { cwd: worktree, systemPrompt: "frozen-prompt" },
    skills: new Map(),
    rules: new Map(),
    agents: new Map(),
  };
  return { root, worktree, configDir, prepared };
}

describe("refreshPreparedSkills", () => {
  test("a new skill rebuilds the prompt listing", () => {
    const { worktree, configDir, prepared } = makeTarget();
    writeSkill(
      worktree,
      ".seri/skills/hot/SKILL.md",
      '---\nname: hot\ndescription: "Loads a new procedure."\n---\n\nBODY-v1\n',
    );
    refreshPreparedSkills(prepared, configDir, () => {});
    expect(prepared.skills.has("hot")).toBe(true);
    expect(prepared.session.systemPrompt).toContain("hot: Loads a new procedure.");
    expect(prepared.session.systemPrompt).toContain("PROJECT-AGENTS");
    expect(prepared.session.systemPrompt).not.toContain("BODY-v1");
  });

  test("an unchanged listing leaves the prompt string alone", () => {
    const { worktree, configDir, prepared } = makeTarget();
    writeSkill(
      worktree,
      ".seri/skills/hot/SKILL.md",
      '---\nname: hot\ndescription: "Loads a new procedure."\n---\n\nBODY-v1\n',
    );
    refreshPreparedSkills(prepared, configDir, () => {});
    const before = prepared.session.systemPrompt;
    refreshPreparedSkills(prepared, configDir, () => {});
    expect(prepared.session.systemPrompt).toBe(before);
  });

  test("a stale session prompt is rebuilt even when the map already matches disk", () => {
    const { worktree, configDir, prepared } = makeTarget();
    writeSkill(
      worktree,
      ".seri/skills/hot/SKILL.md",
      '---\nname: hot\ndescription: "Loads a new procedure."\n---\n\nBODY-v1\n',
    );
    prepared.skills = loadSkillRegistry({
      worktree,
      configDir,
      onWarning: () => {},
      announce: false,
    });
    prepared.session = { cwd: worktree, systemPrompt: "frozen-prompt" };
    refreshPreparedSkills(prepared, configDir, () => {});
    expect(prepared.session.systemPrompt).toContain("hot: Loads a new procedure.");
    expect(prepared.session.systemPrompt).not.toBe("frozen-prompt");
  });

  test("a description edit rebuilds the listing", () => {
    const { worktree, configDir, prepared } = makeTarget();
    const path = join(worktree, ".seri/skills/hot/SKILL.md");
    writeSkill(
      worktree,
      ".seri/skills/hot/SKILL.md",
      '---\nname: hot\ndescription: "Loads a new procedure."\n---\n\nBODY-v1\n',
    );
    prepared.skills = loadSkillRegistry({
      worktree,
      configDir,
      onWarning: () => {},
      announce: false,
    });
    writeFileSync(
      path,
      '---\nname: hot\ndescription: "Loads the edited procedure."\n---\n\nBODY-v1\n',
    );
    refreshPreparedSkills(prepared, configDir, () => {});
    expect(prepared.session.systemPrompt).toContain("hot: Loads the edited procedure.");
    expect(prepared.session.systemPrompt).not.toContain("Loads a new procedure.");
  });

  test("deleting the last skill drops the listing from the prompt", () => {
    const { worktree, configDir, prepared } = makeTarget();
    const path = join(worktree, ".seri/skills/hot/SKILL.md");
    writeSkill(
      worktree,
      ".seri/skills/hot/SKILL.md",
      '---\nname: hot\ndescription: "Loads a new procedure."\n---\n\nBODY-v1\n',
    );
    refreshPreparedSkills(prepared, configDir, () => {});
    expect(prepared.session.systemPrompt).toContain("# Skills");
    rmSync(path);
    refreshPreparedSkills(prepared, configDir, () => {});
    expect(prepared.skills.has("hot")).toBe(false);
    expect(prepared.session.systemPrompt).not.toContain("# Skills");
    expect(prepared.session.systemPrompt).toContain("PROJECT-AGENTS");
  });

  test("a name collision is warned once, not on every unchanged rescan", () => {
    const { worktree, configDir, prepared } = makeTarget();
    prepared.agents = new Map([["hot", true]]);
    writeSkill(
      worktree,
      ".seri/skills/hot/SKILL.md",
      '---\nname: hot\ndescription: "Loads a new procedure."\n---\n\nBODY-v1\n',
    );
    const warnings: string[] = [];
    refreshPreparedSkills(prepared, configDir, (message) => warnings.push(message));
    expect(warnings.some((w) => w.includes("names both an agent and a skill"))).toBe(true);
    warnings.length = 0;
    refreshPreparedSkills(prepared, configDir, (message) => warnings.push(message));
    expect(warnings.some((w) => w.includes("names both an agent and a skill"))).toBe(false);
    expect(warnings.some((w) => w.startsWith("skills from "))).toBe(false);
  });
});
