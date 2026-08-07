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

    // The order matters more than the names: `edit` writes nothing, so an `edit` that is not
    // preceded by a `read_file` and followed by a `write_file` reports success and changes nothing.
    const readIndex = prompt.indexOf("read_file");
    const editIndex = prompt.indexOf("edit", readIndex);
    const writeIndex = prompt.indexOf("write_file", editIndex);
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(editIndex).toBeGreaterThan(readIndex);
    expect(writeIndex).toBeGreaterThan(editIndex);
    expect(prompt).toMatch(/writes nothing|nothing (is )?written/i);
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
