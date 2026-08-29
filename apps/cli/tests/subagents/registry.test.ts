import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import type { MutationContext } from "../../src/checkpoint/wrapTools";
import { DISPATCH_TOOL_NAME, toolDefinitions } from "../../src/provider/tools";
import {
  type AgentSpec,
  agentMutatesFilesystem,
  agentRouteRequest,
  agentToolSet,
  BUILTIN_AGENTS,
  builtinRegistry,
  composeAddendum,
  describeAgent,
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
