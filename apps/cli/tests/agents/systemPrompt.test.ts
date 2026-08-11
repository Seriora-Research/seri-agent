import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, buildVolatileTier } from "../../src/agents/systemPrompt";
import { applyWrite, loadMemory, type MemoryContext } from "../../src/memory/store";

let configDir: string | undefined;
afterEach(() => {
  if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});
// buildVolatileTier's memory param is required (round-4 review: it used to be optional only so
// pre-Stage-6b 3-arg tests kept compiling) — every call below passes an explicit, genuinely empty
// LoadedMemory built from this rather than omitting the argument.
function emptyMemoryCtx(): MemoryContext {
  configDir = mkdtempSync(join(tmpdir(), "seri-memory-"));
  return { configDir, worktree: "/home/x/proj" };
}

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

  test("the assembled system prompt lists every real tool by its own name", () => {
    const prompt = buildSystemPrompt("");

    for (const name of [
      "read_file",
      "write_file",
      "edit",
      "grep",
      "glob",
      "bash",
      "powershell",
      "dispatch_subagents",
    ]) {
      expect(prompt).toContain(`\`${name}\``);
    }
  });

  test("the assembled system prompt tells the model bash/powershell/write_file/edit are destructive and to investigate before overwriting unfamiliar state", () => {
    const prompt = buildSystemPrompt("");

    expect(prompt).toMatch(/destroy work/i);
    expect(prompt).toMatch(/investigate before deleting or overwriting/i);
  });

  // Stage B2: the stable tier (tool guidance) must precede the context tier (AGENTS.md) in the
  // assembled output, and the join between them must match today's separator shape exactly — a
  // naive three-operand join can add an extra "\n\n" that today's conditional two-operand join
  // never produced, since only two operands ever existed before and one was dropped when empty.
  test("stable tier precedes context tier, with no extra or missing separator", () => {
    const withoutAgents = buildSystemPrompt("");
    const agentsFixture = "# Project rules\nUse tabs.";
    const withAgents = buildSystemPrompt(agentsFixture);

    const toolsIndex = withAgents.indexOf("# Calling tools");
    const agentsIndex = withAgents.indexOf(agentsFixture);
    expect(toolsIndex).toBeGreaterThanOrEqual(0);
    expect(agentsIndex).toBeGreaterThan(toolsIndex);

    expect(withAgents).toBe(`${withoutAgents}\n\n${agentsFixture}`);
  });
});

describe("buildVolatileTier", () => {
  test("a cataloged model's identity line uses the resolved displayName", () => {
    const line = buildVolatileTier(
      "openai/gpt-oss-120b",
      "groq",
      "GPT OSS 120B",
      loadMemory(emptyMemoryCtx()),
    );

    expect(line).toContain("GPT OSS 120B");
    expect(line).toContain("groq/openai/gpt-oss-120b");
  });

  test("an uncataloged model (no displayName) still gets an identity line, using the raw id", () => {
    const line = buildVolatileTier("some-raw-id", "groq", undefined, loadMemory(emptyMemoryCtx()));

    expect(line.length).toBeGreaterThan(0);
    expect(line).toContain("some-raw-id");
  });

  // code-review finding on PR #66: a catalog entry whose `name` came back "" (present but empty,
  // not null/undefined) must still fall back to the raw id — `??` doesn't catch that, `||` does.
  test("a catalog entry with an empty-string displayName falls back to the raw id, not a blank label", () => {
    const line = buildVolatileTier("some-raw-id", "groq", "", loadMemory(emptyMemoryCtx()));

    expect(line).not.toContain("named . ");
    expect(line).toContain("some-raw-id");
  });

  // B2: an all-empty LoadedMemory must render no visible memory section at all — this is what
  // keeps a session with no memories yet reading the exact same prompt it read before Stage 6b
  // existed.
  describe("memory tier (Stage 6b, B2 no-regression)", () => {
    test("an all-empty LoadedMemory renders no memory section — just the identity line", () => {
      const line = buildVolatileTier(
        "openai/gpt-oss-120b",
        "groq",
        "GPT OSS 120B",
        loadMemory(emptyMemoryCtx()),
      );
      expect(line).not.toContain("# Memory");
      expect(line).toContain("GPT OSS 120B");
    });

    // The positive case, and the negative control for the test above: a genuinely non-empty
    // memory file must actually change the rendered tier, or the assertion above couldn't be told
    // apart from a function that always drops the memory tier regardless of content.
    test("a non-empty memory file changes the output, contains the entry, and the identity line still comes first", () => {
      const ctx = emptyMemoryCtx();
      applyWrite(
        { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
        ctx,
        "2026-08-11",
      );
      const withMemory = buildVolatileTier("m", "groq", undefined, loadMemory(ctx));
      const withoutMemory = buildVolatileTier("m", "groq", undefined, loadMemory(emptyMemoryCtx()));

      expect(withMemory).not.toBe(withoutMemory);
      expect(withMemory).toContain("# Memory");
      expect(withMemory).toContain("prefers tabs");
      expect(withMemory.indexOf("You are powered by")).toBe(0);
      expect(withMemory.indexOf("# Memory")).toBeGreaterThan(0);
    });
  });
});
