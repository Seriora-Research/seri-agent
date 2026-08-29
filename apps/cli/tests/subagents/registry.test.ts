import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelCatalog } from "@seri/model-catalog";
import type { ToolExecutionOptions } from "ai";
import type { MutationContext } from "../../src/checkpoint/wrapTools";
import { DISPATCH_TOOL_NAME, toolDefinitions } from "../../src/provider/tools";
import {
  type AgentRegistry,
  type AgentSpec,
  agentMutatesFilesystem,
  agentRouteRequest,
  agentToolSet,
  BUILTIN_AGENTS,
  builtinRegistry,
  composeAddendum,
  describeAgent,
  loadAgentRegistry,
} from "../../src/subagents/registry";

function execOpts(): ToolExecutionOptions<Record<string, unknown>> {
  return { toolCallId: "c1", messages: [], context: {} };
}

function agent(name: string): AgentSpec {
  const spec = builtinRegistry().get(name);
  if (spec === undefined) throw new Error(`no built-in agent named "${name}"`);
  return spec;
}

describe("agentToolSet", () => {
  test("explore and plan are both exactly read_file/grep/glob, and identical to each other", () => {
    expect(Object.keys(agentToolSet(agent("explore"))).sort()).toEqual([
      "glob",
      "grep",
      "read_file",
    ]);
    expect(Object.keys(agentToolSet(agent("plan"))).sort()).toEqual(["glob", "grep", "read_file"]);
  });

  test("oracle is exactly the read-only set and has no write_file/edit/bash/powershell", () => {
    const tools = agentToolSet(agent("oracle"));
    expect(Object.keys(tools).sort()).toEqual(["glob", "grep", "read_file"]);
    expect(tools.write_file).toBeUndefined();
    expect(tools.edit).toBeUndefined();
    expect(tools.bash).toBeUndefined();
    expect(tools.powershell).toBeUndefined();
    expect(tools[DISPATCH_TOOL_NAME]).toBeUndefined();
  });

  test("test adds bash/powershell to the read-only set and has no write_file/edit", () => {
    const tools = agentToolSet(agent("test"));
    expect(Object.keys(tools).sort()).toEqual(["bash", "glob", "grep", "powershell", "read_file"]);
    expect(tools.write_file).toBeUndefined();
    expect(tools.edit).toBeUndefined();
  });

  test("code has every key of toolDefinitions", () => {
    expect(Object.keys(agentToolSet(agent("code"))).sort()).toEqual(
      Object.keys(toolDefinitions).sort(),
    );
  });

  test("recursion guard: no built-in agent's ToolSet contains dispatch_subagents", () => {
    for (const spec of BUILTIN_AGENTS) {
      expect(Object.keys(agentToolSet(spec))).not.toContain(DISPATCH_TOOL_NAME);
    }
  });

  test("explore read_file resolves relative paths against the session cwd, not process.cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seri-agent-cwd-"));
    writeFileSync(join(dir, "note.txt"), "session-copy");
    try {
      const tools = agentToolSet(agent("explore"), undefined, dir);
      const read = await tools.read_file?.execute?.({ path: "note.txt" }, execOpts());
      expect(read).toBe("session-copy");
      expect(process.cwd()).not.toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Round-trip regression for the write-ledger gap: a `code` subagent's write_file was never
  // wrapped with anything at all, so its writes were never recorded (writeLedger.ts's recordWrite)
  // and a later /undo could never prove one of its files safe to delete — see wrapTools.ts's
  // withMutationRecording for the full mechanism this closes.
  test("write_file is recorded via onAfterMutation when one is provided, with no other tool wrapped", async () => {
    const calls: MutationContext[] = [];
    const tools = agentToolSet(agent("code"), (context) => calls.push(context));

    const root = mkdtempSync(join(tmpdir(), "seri-agent-tools-test-"));
    const path = join(root, "a.txt");
    try {
      await tools.write_file?.execute?.({ path, content: "hello" }, execOpts());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const [recorded] = calls;
    expect(calls).toHaveLength(1);
    expect(recorded?.tool).toBe("write_file");
    expect((recorded?.args as { path: string } | undefined)?.path).toBe(path);
  });
});

describe("composeAddendum", () => {
  test("names each built-in's own tools and says it cannot dispatch subagents", () => {
    for (const spec of BUILTIN_AGENTS) {
      expect(spec.addendum).toContain("cannot dispatch subagents");
      for (const name of Object.keys(agentToolSet(spec))) {
        expect(spec.addendum).toContain(name);
      }
    }
  });

  test("plan is never told to write; test is never told to fix", () => {
    expect(agent("plan").addendum).toMatch(/cannot write/i);
    expect(agent("test").addendum).toMatch(/cannot fix/i);
  });

  test("oracle is an advisor, not an explorer, and cannot write or run commands", () => {
    const text = agent("oracle").addendum;
    expect(text).toMatch(/senior engineer|advis/i);
    expect(text).toMatch(/cannot write/i);
    expect(text).not.toMatch(/report what you find/i);
  });

  test("an agent whose own prompt states no limits still gets the whitelist sentence", () => {
    expect(composeAddendum({ name: "quiet", job: "", toolNames: ["read_file"] })).toContain(
      "your only tools this run are: read_file",
    );
  });
});

describe("agentMutatesFilesystem", () => {
  // The predicate dispatch.ts keys both its pre-dispatch checkpoint and its writer-serialization
  // on: explore/plan hold no tool in FS_MUTATING_TOOL_NAMES, code/test both do (test via
  // bash/powershell, not write_file) and must be treated the same way as a result.
  test("explore and plan do not mutate the filesystem", () => {
    expect(agentMutatesFilesystem(agent("explore"))).toBe(false);
    expect(agentMutatesFilesystem(agent("plan"))).toBe(false);
  });

  test("oracle does not mutate the filesystem", () => {
    expect(agentMutatesFilesystem(agent("oracle"))).toBe(false);
  });

  test("code and test both mutate the filesystem", () => {
    expect(agentMutatesFilesystem(agent("code"))).toBe(true);
    expect(agentMutatesFilesystem(agent("test"))).toBe(true);
  });
});

describe("builtinRegistry", () => {
  test("holds exactly the five parent-callable agents; the archivist is not one of them", () => {
    expect([...builtinRegistry().keys()]).toEqual(["explore", "plan", "code", "test", "oracle"]);
    expect(builtinRegistry().has("archivist")).toBe(false);
  });

  test("every built-in carries a description, so every one earns a dispatch line", () => {
    for (const spec of BUILTIN_AGENTS) expect(spec.description.length).toBeGreaterThan(0);
  });

  test("no built-in carries a route of its own — they inherit or take an env pin", () => {
    for (const spec of BUILTIN_AGENTS) expect(spec.request).toBeUndefined();
  });
});

describe("describeAgent", () => {
  test("the tool grant in the prose is read off the same toolNames the ToolSet is built from", () => {
    const line = describeAgent(agent("test"));
    expect(line).toContain('"test"');
    for (const name of Object.keys(agentToolSet(agent("test")))) expect(line).toContain(name);
    expect(line).not.toContain("write_file");
  });
});

describe("agentRouteRequest", () => {
  const withRoute: AgentSpec = {
    ...agent("explore"),
    name: "reviewer",
    request: { model: "claude-sonnet-5", provider: "anthropic", effort: "medium" },
  };

  test("a complete pair on the task wins over the agent file's own", () => {
    expect(agentRouteRequest(withRoute, { model: "gpt-5", provider: "openai" })).toEqual({
      model: "gpt-5",
      provider: "openai",
      effort: "medium",
    });
  });

  test("the agent file's pair is used when the task names none", () => {
    expect(agentRouteRequest(withRoute, undefined)).toEqual({
      model: "claude-sonnet-5",
      provider: "anthropic",
      effort: "medium",
    });
  });

  test("the task's effort wins over the file's, without disturbing the pair", () => {
    expect(agentRouteRequest(withRoute, { effort: "high" })).toEqual({
      model: "claude-sonnet-5",
      provider: "anthropic",
      effort: "high",
    });
  });

  test("a model with no provider is dropped rather than half-applied", () => {
    expect(agentRouteRequest(agent("explore"), { model: "gpt-5" })).toEqual({
      model: undefined,
      provider: undefined,
      effort: undefined,
    });
  });
});

describe("loadAgentRegistry", () => {
  let roots: string[] = [];

  function makeTree(files: Record<string, string>): { worktree: string; configDir: string } {
    const root = mkdtempSync(join(tmpdir(), "seri-agents-"));
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

  function load(
    files: Record<string, string>,
    catalog: ModelCatalog = { fetchedAt: "", entries: [] },
  ): { agents: AgentRegistry; warnings: string[] } {
    const { worktree, configDir } = makeTree(files);
    const warnings: string[] = [];
    const agents = loadAgentRegistry({
      worktree,
      configDir,
      catalog,
      configured: new Set(["anthropic"]),
      onWarning: (message) => warnings.push(message),
    });
    return { agents, warnings };
  }

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots = [];
  });

  test("with no agents directory anywhere, the registry is exactly the built-ins", () => {
    expect([...load({}).agents.keys()]).toEqual(["explore", "plan", "code", "test", "oracle"]);
  });

  test("a project file is found by walking up from the worktree, not only in it", () => {
    const { agents } = load({
      "project/.seri/agents/reviewer.md": "---\ndescription: grades a diff\n---\nreview it\n",
    });
    expect(agents.get("reviewer")?.source).toBe("project");
    expect(agents.get("reviewer")?.description).toBe("grades a diff");
  });

  // ~/.seri/agents is the default profile's GLOBAL scope. Every repository under $HOME would
  // otherwise find it on the way up and claim it as its own project scope — and a --profile run
  // would reach the default root's agents through that back door.
  test("the default profile root's own agents/ is never adopted as a project scope", () => {
    const root = mkdtempSync(join(tmpdir(), "seri-agents-home-"));
    roots.push(root);
    const worktree = join(root, "project");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(root, ".seri", "agents"), { recursive: true });
    writeFileSync(join(root, ".seri", "agents", "global-only.md"), "---\ndescription: d\n---\nb\n");
    const originalHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const agents = loadAgentRegistry({
        worktree,
        configDir: join(root, "work"),
        catalog: { fetchedAt: "", entries: [] },
        configured: new Set(["anthropic"]),
        onWarning: () => {},
      });
      expect(agents.has("global-only")).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  test("the profile root's agents/ loads as the global scope", () => {
    const { agents } = load({
      "profile/agents/scribe.md": "---\ndescription: writes notes\n---\nwrite\n",
    });
    expect(agents.get("scribe")?.source).toBe("user");
  });

  test("a project agent shadows a global one of the same name", () => {
    const { agents } = load({
      "profile/agents/reviewer.md": "---\ndescription: global\n---\nglobal body\n",
      "project/.seri/agents/reviewer.md": "---\ndescription: project\n---\nproject body\n",
    });
    expect(agents.get("reviewer")?.description).toBe("project");
    expect(agents.get("reviewer")?.source).toBe("project");
  });

  test("a file taking a built-in's name is skipped and the built-in survives untouched", () => {
    const { agents, warnings } = load({
      "project/.seri/agents/code.md": "---\ndescription: impostor\ntools: Read\n---\nb\n",
    });
    expect(agents.get("code")?.source).toBe("builtin");
    expect(warnings.join(" ")).toContain("code.md");
  });

  test("a file taking a slash command's name is skipped", () => {
    const { agents, warnings } = load({
      "project/.seri/agents/compact.md": "---\ndescription: impostor\n---\nb\n",
    });
    expect(agents.has("compact")).toBe(false);
    expect(warnings.join(" ")).toContain("compact.md");
  });

  // SERI_ROLE_ARCHIVIST_MODEL is a real env pin. A file free to claim that name would inherit it
  // silently, which is why every routing target is reserved and not just the dispatchable ones.
  test("a file taking a routing target's name is skipped", () => {
    const { agents, warnings } = load({
      "project/.seri/agents/archivist.md": "---\ndescription: impostor\n---\nb\n",
    });
    expect(agents.has("archivist")).toBe(false);
    expect(warnings.join(" ")).toContain("archivist.md");
  });

  test("a malformed file is skipped with a warning and the rest of the directory still loads", () => {
    const { agents, warnings } = load({
      "project/.seri/agents/broken.md": "---\ndescription: [unclosed\n---\nb\n",
      "project/.seri/agents/fine.md": "---\ndescription: fine\n---\nb\n",
    });
    expect(agents.has("broken")).toBe(false);
    expect(agents.has("fine")).toBe(true);
    expect(warnings.join(" ")).toContain("broken.md");
  });

  test("non-markdown files in the directory are ignored entirely", () => {
    const { agents, warnings } = load({
      "project/.seri/agents/notes.txt": "not an agent",
      "project/.seri/agents/README": "not an agent either",
    });
    expect([...agents.keys()]).toEqual(["explore", "plan", "code", "test", "oracle"]);
    expect(warnings).toEqual([]);
  });

  test("a model: is resolved against the configured providers' catalog entries", () => {
    const catalog: ModelCatalog = {
      fetchedAt: "",
      entries: [
        {
          id: "claude-sonnet-5",
          provider: "anthropic",
          displayName: "Claude Sonnet 5",
          family: null,
          contextWindow: 200_000,
          maxOutputTokens: 8_000,
          toolCall: true,
          reasoning: true,
          pricing: undefined,
        },
      ],
    };
    const { agents } = load(
      {
        "project/.seri/agents/deep.md":
          "---\ndescription: d\nmodel: claude-sonnet-5[effort=high]\n---\nb\n",
      },
      catalog,
    );
    expect(agents.get("deep")?.request).toEqual({
      model: "claude-sonnet-5",
      provider: "anthropic",
      effort: "high",
    });
  });

  test("a file-defined agent carries no ToolSet the dispatch tool could recurse through", () => {
    const { agents } = load({
      "project/.seri/agents/hostile.md": `---\ndescription: d\ntools: Read, ${DISPATCH_TOOL_NAME}\n---\nb\n`,
    });
    const spec = agents.get("hostile");
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(Object.keys(agentToolSet(spec))).toEqual(["read_file"]);
    expect(Object.keys(agentToolSet(spec))).not.toContain(DISPATCH_TOOL_NAME);
  });
});
