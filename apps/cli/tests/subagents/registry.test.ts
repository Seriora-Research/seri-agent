import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelCatalog } from "@seri/model-catalog";
import type { ToolExecutionOptions } from "ai";
import { foldsCase } from "../../src/caseFold";
import type { MutationContext } from "../../src/checkpoint/wrapTools";
import { DISPATCH_TOOL_NAME, type ToolName, toolDefinitions } from "../../src/provider/tools";
import { TODO_TOOL_NAME } from "../../src/todo/tool";
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

function fileAgent(name: string, toolNames: readonly ToolName[]): AgentSpec {
  return {
    name,
    description: `${name} agent`,
    toolNames,
    addendum: composeAddendum({ name, job: "", toolNames }),
    request: undefined,
    source: "project",
    filePath: `/p/.seri/agents/${name}.md`,
  };
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

  test("a file-defined writer has every key it named and no dispatch_subagents", () => {
    const spec = fileAgent("writer", ["write_file", "read_file", "grep", "glob"]);
    expect(Object.keys(agentToolSet(spec)).sort()).toEqual(
      ["glob", "grep", "read_file", "write_file"].sort(),
    );
    expect(Object.keys(agentToolSet(spec))).not.toContain(DISPATCH_TOOL_NAME);
    expect(Object.keys(agentToolSet(spec))).not.toContain(TODO_TOOL_NAME);
  });

  test("a file-defined tester adds bash/powershell to the read-only set and has no write_file/edit", () => {
    const tools = agentToolSet(
      fileAgent("tester", ["bash", "powershell", "read_file", "grep", "glob"]),
    );
    expect(Object.keys(tools).sort()).toEqual(["bash", "glob", "grep", "powershell", "read_file"]);
    expect(tools.write_file).toBeUndefined();
    expect(tools.edit).toBeUndefined();
  });

  test("recursion guard: no built-in agent's ToolSet contains dispatch_subagents or todo", () => {
    for (const spec of BUILTIN_AGENTS) {
      expect(Object.keys(agentToolSet(spec))).not.toContain(DISPATCH_TOOL_NAME);
      expect(Object.keys(agentToolSet(spec))).not.toContain(TODO_TOOL_NAME);
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





  test("write_file is recorded via onAfterMutation when one is provided, with no other tool wrapped", async () => {
    const calls: MutationContext[] = [];
    const tools = agentToolSet(fileAgent("writer", ["write_file", "read_file"]), (context) =>
      calls.push(context),
    );

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

  test("plan is never told to write", () => {
    expect(agent("plan").addendum).toMatch(/cannot write/i);
  });

  test("an agent whose own prompt states no limits still gets the whitelist sentence", () => {
    expect(composeAddendum({ name: "quiet", job: "", toolNames: ["read_file"] })).toContain(
      "your only tools this run are: read_file",
    );
  });
});

describe("agentMutatesFilesystem", () => {



  test("explore and plan do not mutate the filesystem", () => {
    expect(agentMutatesFilesystem(agent("explore"))).toBe(false);
    expect(agentMutatesFilesystem(agent("plan"))).toBe(false);
  });

  test("a file-defined writer or tester mutates the filesystem", () => {
    expect(agentMutatesFilesystem(fileAgent("writer", ["write_file", "read_file"]))).toBe(true);
    expect(agentMutatesFilesystem(fileAgent("tester", ["bash", "read_file"]))).toBe(true);
  });
});

describe("builtinRegistry", () => {
  test("holds exactly the two parent-callable agents; the archivist is not one of them", () => {
    expect([...builtinRegistry().keys()]).toEqual(["explore", "plan"]);
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
    const spec = fileAgent("tester", ["bash", "read_file", "grep"]);
    const line = describeAgent(spec);
    expect(line).toContain('"tester"');
    for (const name of Object.keys(agentToolSet(spec))) expect(line).toContain(name);
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
      onWarning: (message) => warnings.push(message),
    });
    return { agents, warnings };
  }

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots = [];
  });

  test("with no agents directory anywhere, the registry is exactly the built-ins", () => {
    expect([...load({}).agents.keys()]).toEqual(["explore", "plan"]);
  });

  test("a project file is found by walking up from the worktree, not only in it", () => {
    const { agents } = load({
      "project/.seri/agents/reviewer.md": "---\ndescription: grades a diff\n---\nreview it\n",
    });
    expect(agents.get("reviewer")?.source).toBe("project");
    expect(agents.get("reviewer")?.description).toBe("grades a diff");
  });




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
        onWarning: () => {},
      });
      expect(agents.has("global-only")).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });





  (foldsCase() ? test : test.skip)(
    "the global agents dir is refused as a project scope even in a different case",
    () => {
      const root = mkdtempSync(join(tmpdir(), "seri-agents-case-"));
      roots.push(root);
      mkdirSync(join(root, ".seri", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".seri", "agents", "global-only.md"),
        "---\ndescription: d\n---\nb\n",
      );
      const originalHome = process.env.HOME;
      process.env.HOME = root.toUpperCase();
      try {
        const agents = loadAgentRegistry({
          worktree: root,
          configDir: join(root, "work"),
          catalog: { fetchedAt: "", entries: [] },
          onWarning: () => {},
        });
        expect(agents.has("global-only")).toBe(false);
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    },
  );

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

  test("two files in one scope naming the same agent warn; the cross-scope shadow stays silent", () => {
    const { agents, warnings } = load({
      "project/.seri/agents/aaa.md": "---\nname: dup\ndescription: first\n---\nb\n",
      "project/.seri/agents/zzz.md": "---\nname: dup\ndescription: second\n---\nb\n",
    });
    expect(agents.get("dup")?.description).toBe("second");
    const duplicate = warnings.find((w) => w.includes("aaa.md") && w.includes("zzz.md"));
    expect(duplicate).toContain('"dup"');
    const shadow = load({
      "profile/agents/reviewer.md": "---\ndescription: global\n---\nb\n",
      "project/.seri/agents/reviewer.md": "---\ndescription: project\n---\nb\n",
    });
    expect(shadow.warnings.find((w) => w.includes("both name"))).toBeUndefined();
  });

  test("a file taking a dropped built-in name is skipped and does not become an agent", () => {
    const { agents, warnings } = load({
      "project/.seri/agents/code.md": "---\ndescription: impostor\ntools: Read\n---\nb\n",
    });
    expect(agents.has("code")).toBe(false);
    expect(warnings.join(" ")).toContain("code.md");
  });

  test("a file taking a slash command's name is skipped", () => {
    const { agents, warnings } = load({
      "project/.seri/agents/compact.md": "---\ndescription: impostor\n---\nb\n",
    });
    expect(agents.has("compact")).toBe(false);
    expect(warnings.join(" ")).toContain("compact.md");
  });



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
    expect([...agents.keys()]).toEqual(["explore", "plan"]);
    expect(warnings).toEqual([]);
  });



  test("a scope that loaded something says so, naming the directory and the agent", () => {
    const { warnings } = load({
      "project/.seri/agents/reviewer.md": "---\ndescription: grades a diff\n---\nreview it\n",
    });
    const line = warnings.find((message) => message.startsWith("agents from "));
    expect(line).toContain(join(".seri", "agents"));
    expect(line).toContain("reviewer");
  });

  test("a scope that loaded nothing says nothing", () => {
    expect(load({}).warnings).toEqual([]);
  });



  test("a model: is resolved against the catalog, whatever providers are configured", () => {
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
    expect(Object.keys(agentToolSet(spec))).not.toContain(TODO_TOOL_NAME);
  });
});
