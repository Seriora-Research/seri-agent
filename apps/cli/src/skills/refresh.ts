import { loadAgentsFile } from "../agents/loadAgentsFile";
import { buildSystemPrompt } from "../agents/systemPrompt";
import type { RuleRegistry } from "../rules/registry";
import {
  loadSkillRegistry,
  renderSkillsTier,
  type SkillRegistry,
  warnOnNameCollisions,
} from "./registry";

function skillNamesKey(skills: SkillRegistry): string {
  return [...skills.keys()].sort().join("\n");
}

export type SkillRefreshTarget = {
  session: { cwd: string; systemPrompt: string };
  skills: SkillRegistry;
  rules: RuleRegistry;
  agents: { has(name: string): boolean };
};

function promptCarriesListing(prompt: string, listing: string): boolean {
  return listing === "" ? !prompt.includes("# Skills\n") : prompt.includes(listing);
}

export function refreshPreparedSkills(
  prepared: SkillRefreshTarget,
  configDir: string,
  onWarning: (message: string) => void,
): void {
  const previous = prepared.skills;
  const previousListing = renderSkillsTier([...previous.values()]);
  const previousNames = skillNamesKey(previous);
  const skills = loadSkillRegistry({
    worktree: prepared.session.cwd,
    configDir,
    onWarning,
    announce: false,
  });
  prepared.skills = skills;
  if (skillNamesKey(skills) !== previousNames) {
    warnOnNameCollisions(skills, prepared.agents, onWarning);
  }
  const listing = renderSkillsTier([...skills.values()]);
  if (listing === previousListing && promptCarriesListing(prepared.session.systemPrompt, listing)) {
    return;
  }
  prepared.session.systemPrompt = buildSystemPrompt({
    agentsContent: loadAgentsFile(prepared.session.cwd),
    skills: [...skills.values()],
    rules: [...prepared.rules.values()],
  });
}
