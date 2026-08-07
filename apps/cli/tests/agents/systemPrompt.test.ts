import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../../src/agents/systemPrompt";

// These assert on meaning, not on wording: each check is a phrase the measured failure needs
// present, matched case-insensitively, so the prompt can be reworded without the test going red
// for a synonym. What they must not become is a snapshot of the whole string.
describe("buildSystemPrompt", () => {
  test("the assembled system prompt instructs the model to call tools rather than describe them", () => {
    const prompt = buildSystemPrompt("");

    expect(prompt).toMatch(/call your tools/i);
    expect(prompt).toMatch(/do not describe/i);
  });

  test("the assembled system prompt teaches the read_file -> edit -> write_file sequence", () => {
    const prompt = buildSystemPrompt("");

    // The numbered steps, not the section heading. The heading itself reads "Changing a file:
    // read_file, then edit, then write_file", so an ordering assertion over bare `indexOf` matches
    // grew green on the heading alone and stayed green with the entire body deleted — and
    // `indexOf("edit")` matched `credit` or `editor` anywhere earlier in the prompt just as well.
    const one = prompt.indexOf("1. `read_file`");
    const two = prompt.indexOf("2. `edit`");
    const three = prompt.indexOf("3. `write_file`");
    expect(one).toBeGreaterThanOrEqual(0);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);

    expect(prompt).toMatch(/writes nothing|nothing (is )?written/i);
    // The other half of the same trap: `edit` throws on a non-unique oldString rather than taking
    // the first match, so the prompt has to ask for a unique one.
    expect(prompt).toMatch(/exactly once/i);
  });

  // The case the old assembly collapsed to 29 characters: outside a repo with an AGENTS.md,
  // `loadAgentsFile` returns "" and the model got "You are seri, a coding agent." and nothing else.
  test("a project with no AGENTS.md still gets the full tool guidance", () => {
    const withoutAgents = buildSystemPrompt("");
    const withAgents = buildSystemPrompt("# Project rules\nUse tabs.");

    expect(withoutAgents).toMatch(/call your tools/i);
    expect(withoutAgents).toMatch(/read_file/);
    expect(withoutAgents.length).toBeGreaterThan(500);
    // AGENTS.md is added to the guidance, never a replacement for it.
    expect(withAgents.startsWith(withoutAgents)).toBe(true);
    expect(withAgents).toContain("# Project rules\nUse tabs.");
  });
});
