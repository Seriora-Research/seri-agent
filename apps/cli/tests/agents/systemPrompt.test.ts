import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, buildVolatileTier, familyOverlay } from "../../src/agents/systemPrompt";
import { applyWrite, loadMemory, type MemoryContext } from "../../src/memory/store";
import {
  bashFirstSteerIn,
  CLAUDE_CODE_BASH_FIRST_ATTACHMENT,
  expectDedicatedFileTools,
  expectNoBashFirstSteer,
} from "./bashFirstSteer";

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
    const prompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

    expect(prompt).toMatch(/call your tools/i);
    expect(prompt).toMatch(/do not describe/i);
  });

  test("the assembled system prompt teaches the read_file -> edit -> write_file sequence", () => {
    const prompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

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
    const withoutAgents = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });
    const withAgents = buildSystemPrompt({
      agentsContent: "# Project rules\nUse tabs.",
      skills: [],
      rules: [],
    });

    expect(withoutAgents).toMatch(/call your tools/i);
    expect(withoutAgents).toMatch(/read_file/);
    expect(withoutAgents.length).toBeGreaterThan(500);
    // AGENTS.md is added to the guidance, never a replacement for it.
    expect(withAgents.startsWith(withoutAgents)).toBe(true);
    expect(withAgents).toContain("# Project rules\nUse tabs.");
  });

  test("the assembled system prompt lists every real tool by its own name", () => {
    const prompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

    for (const name of [
      "read_file",
      "write_file",
      "edit",
      "grep",
      "glob",
      "bash",
      "powershell",
      "dispatch_subagents",
      "todo",
    ]) {
      expect(prompt).toContain(`\`${name}\``);
    }
    expect(prompt).not.toContain("`ask_user`");
  });

  test("the assembled system prompt tells the model write_file and the shells can destroy work, and to investigate before overwriting unfamiliar state", () => {
    const prompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

    expect(prompt).toMatch(/destroy work/i);
    expect(prompt).toMatch(/investigate before deleting or overwriting/i);
    expect(prompt).not.toMatch(/`edit` can destroy work/i);
  });

  test("the assembled system prompt says to persist, inspect the worktree before asking, and treat tool results as evidence", () => {
    const prompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

    expect(prompt).toMatch(/persist until/i);
    expect(prompt).toMatch(/inspect the worktree/i);
    expect(prompt).toMatch(/tool results are evidence/i);
  });

  test("the assembled system prompt says a needed tool call happens in the same response, not as a later promise", () => {
    const prompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

    expect(prompt).toMatch(/same response/i);
    expect(prompt).not.toMatch(/do not describe a call, plan one/i);
  });

  test("the stable prompt lists both shells and refuses to translate them, without naming this machine's OS", () => {
    const prompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

    expect(prompt).toContain("`bash`");
    expect(prompt).toContain("`powershell`");
    expect(prompt).toMatch(/does not translate|no translation/i);
    expect(prompt).not.toMatch(/this machine is/i);
    expect(prompt).not.toMatch(/`powershell` on Windows/i);
  });

  test("the assembled system prompt says sibling read_file/grep/glob calls in one step run together, and that a write is a barrier", () => {
    const prompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

    expect(prompt).toMatch(/read_file[\s\S]*grep[\s\S]*glob/i);
    expect(prompt).toMatch(/one step/i);
    expect(prompt).toMatch(/together/i);
    expect(prompt).toMatch(/barrier/i);
    expect(prompt).toMatch(/one at a time/i);
  });

  test("the assembled system prompt says the harness does not translate bash and powershell into each other", () => {
    const prompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

    expect(prompt).toMatch(/does not translate|no translation/i);
    expect(prompt).toMatch(/bash/i);
    expect(prompt).toMatch(/powershell/i);
  });

  test("the assembled system prompt allows AGENTS.md and .seri contracts when the user asks, and forbids using them as memory", () => {
    const prompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

    expect(prompt).toMatch(/AGENTS\.md/);
    expect(prompt).toMatch(/\.seri\/rules/);
    expect(prompt).toMatch(/\.seri\/agents/);
    expect(prompt).toMatch(/\.seri\/hooks/);
    expect(prompt).toMatch(/when the user asks/i);
    expect(prompt).toMatch(/remember|govern/i);
    expect(prompt).not.toMatch(/Do not create or edit `AGENTS\.md`/);
  });

  test("the stable prompt does not name skill or mcp, which are absent unless this session composed them", () => {
    const prompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

    expect(prompt).not.toMatch(/`skill`/);
    expect(prompt).not.toMatch(/`mcp`/);
  });

  test("composeSubagents false omits parent-only tools from # Tools, and still names the builtins", () => {
    const attended = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });
    const scheduled = buildSystemPrompt({
      agentsContent: "",
      skills: [],
      rules: [],
      composeSubagents: false,
    });

    expect(attended).toContain("`todo`");
    expect(attended).toContain("`dispatch_subagents`");

    expect(scheduled).not.toContain("`todo`");
    expect(scheduled).not.toContain("`dispatch_subagents`");
    expect(scheduled).toContain("`read_file`");
    expect(scheduled).toContain("`grep`");
    expect(scheduled).toContain("`glob`");
  });

  test("the assembled system prompt prefers dedicated tools over a shell for file work", () => {
    for (const composeSubagents of [true, false] as const) {
      const prompt = buildSystemPrompt({
        agentsContent: "",
        skills: [],
        rules: [],
        composeSubagents,
      });
      expectDedicatedFileTools(prompt);
    }
  });

  test("the assembled system prompt never contains a bash-first file-I/O steer", () => {
    for (const composeSubagents of [true, false] as const) {
      const prompt = buildSystemPrompt({
        agentsContent: "",
        skills: [],
        rules: [],
        composeSubagents,
      });
      expectNoBashFirstSteer(prompt);
    }
  });

  test("the bash-first forbidden matcher matches Claude Code's attachment", () => {
    expect(bashFirstSteerIn(CLAUDE_CODE_BASH_FIRST_ATTACHMENT)).toBe(
      "Do your work through the Bash tool",
    );
    expect(
      bashFirstSteerIn(
        "Prefer the dedicated tools over a shell for file work: `read_file` instead of `cat`",
      ),
    ).toBeUndefined();
  });

  // Stage B2: the stable tier (tool guidance) must precede the context tier (AGENTS.md) in the
  // assembled output, and the join between them must match today's separator shape exactly — a
  // naive three-operand join can add an extra "\n\n" that today's conditional two-operand join
  // never produced, since only two operands ever existed before and one was dropped when empty.
  test("stable tier precedes context tier, with no extra or missing separator", () => {
    const withoutAgents = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });
    const agentsFixture = "# Project rules\nUse tabs.";
    const withAgents = buildSystemPrompt({ agentsContent: agentsFixture, skills: [], rules: [] });

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
    expect(line).toMatch(/^You are powered by the model named GPT OSS 120B\./m);
    expect(line).not.toContain("exact model ID");
    expect(line).not.toContain("groq");
    expect(line).not.toContain("openai/gpt-oss-120b");
  });

  test("an uncataloged model (no displayName) still gets an identity line, using the raw id", () => {
    const line = buildVolatileTier("some-raw-id", "groq", undefined, loadMemory(emptyMemoryCtx()));

    expect(line.length).toBeGreaterThan(0);
    expect(line).toContain("some-raw-id");
    expect(line).not.toContain("exact model ID");
    expect(line).not.toContain("groq");
  });

  // code-review finding on PR #66: a catalog entry whose `name` came back "" (present but empty,
  // not null/undefined) must still fall back to the raw id — `??` doesn't catch that, `||` does.
  test("a catalog entry with an empty-string displayName falls back to the raw id, not a blank label", () => {
    const line = buildVolatileTier("some-raw-id", "groq", "", loadMemory(emptyMemoryCtx()));

    expect(line).not.toContain("named . ");
    expect(line).toContain("some-raw-id");
    expect(line).not.toContain("exact model ID");
    expect(line).not.toContain("groq");
  });

  test("an uncataloged slashed id uses the last path segment, not a provider prefix", () => {
    const line = buildVolatileTier(
      "minimax/minimax-m3:free",
      "openrouter",
      undefined,
      loadMemory(emptyMemoryCtx()),
    );

    expect(line).toContain("minimax-m3:free");
    expect(line).not.toContain("openrouter");
    expect(line).not.toContain("minimax/minimax-m3:free");
  });

  // B2: an all-empty LoadedMemory must render no visible memory section at all — this is what
  // keeps a session with no memories yet reading the exact same prompt it read before Stage 6b
  // existed.
  describe("memory tier (Stage 6b, B2 no-regression)", () => {
    test("an all-empty LoadedMemory renders no memory section — just identity and the machine line", () => {
      const line = buildVolatileTier(
        "openai/gpt-oss-120b",
        "groq",
        "GPT OSS 120B",
        loadMemory(emptyMemoryCtx()),
        { platform: "linux" },
      );
      expect(line).not.toContain("# Memory");
      expect(line).toContain("GPT OSS 120B");
      expect(line).toMatch(/this machine is linux/i);
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

  test("names the machine and the shell to use from the injected platform", () => {
    const memory = loadMemory(emptyMemoryCtx());
    const linux = buildVolatileTier("m", "groq", undefined, memory, { platform: "linux" });
    expect(linux).toMatch(/this machine is linux/i);
    expect(linux).toMatch(/use `bash`/i);

    const win = buildVolatileTier("m", "groq", undefined, memory, { platform: "win32" });
    expect(win).toMatch(/this machine is windows/i);
    expect(win).toMatch(/use `powershell`/i);

    const mac = buildVolatileTier("m", "groq", undefined, memory, { platform: "darwin" });
    expect(mac).toMatch(/this machine is macos/i);
    expect(mac).toMatch(/use `bash`/i);
  });

  test("the volatile tier never contains a bash-first file-I/O steer", () => {
    const memory = loadMemory(emptyMemoryCtx());
    for (const platform of ["linux", "win32", "darwin"] as const) {
      for (const family of [null, "llama"] as const) {
        const line = buildVolatileTier("m", "groq", undefined, memory, { platform, family });
        expectNoBashFirstSteer(line);
      }
    }
  });

  test("a llama family adds the overlay; a null family is the same identity-plus-platform without it", () => {
    const memory = loadMemory(emptyMemoryCtx());
    const none = buildVolatileTier("m", "groq", undefined, memory, {
      family: null,
      platform: "linux",
    });
    const llama = buildVolatileTier("m", "groq", undefined, memory, {
      family: "llama",
      platform: "linux",
    });

    expect(none).not.toMatch(/text that looks like a call is not a call/i);
    expect(llama).toMatch(/text that looks like a call is not a call/i);
    expect(llama.startsWith(none)).toBe(true);
    expect(llama.length).toBeGreaterThan(none.length);
  });
});

describe("familyOverlay", () => {
  test("null, empty, and unmeasured families return nothing", () => {
    expect(familyOverlay(null)).toBeUndefined();
    expect(familyOverlay(undefined)).toBeUndefined();
    expect(familyOverlay("")).toBeUndefined();
    expect(familyOverlay("gpt-oss")).toBeUndefined();
    expect(familyOverlay("claude-sonnet")).toBeUndefined();
  });

  test("the llama family, the one measured to narrate calls as text, gets the enforcement overlay", () => {
    const overlay = familyOverlay("llama");
    expect(overlay).toBeDefined();
    expect(overlay).toMatch(/same response/i);
    expect(overlay).toMatch(/text that looks like a call is not a call/i);
    expect(familyOverlay("Llama")).toBe(overlay);
    expect(familyOverlay("  LLAMA  ")).toBe(overlay);
  });
});

type SystemPromptOpts = Parameters<typeof buildSystemPrompt>[0];
const _noModeOnPrompt: Extract<keyof SystemPromptOpts, "permissionMode"> extends never
  ? true
  : false = true;
void _noModeOnPrompt;

type VolatileOpts = NonNullable<Parameters<typeof buildVolatileTier>[4]>;
const _noModeOnVolatile: Extract<keyof VolatileOpts, "permissionMode"> extends never
  ? true
  : false = true;
void _noModeOnVolatile;
