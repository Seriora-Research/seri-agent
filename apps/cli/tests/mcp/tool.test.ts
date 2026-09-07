import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { createMcpClients, type DialFn, type McpClientHandle } from "../../src/mcp/client";
import { MCP_TOOL_NAME, mcpCallSubject, withMcp } from "../../src/mcp/tool";
import type {
  McpCatalog,
  McpEntry,
  McpRegistry,
  McpServerSpec,
  McpToolInfo,
} from "../../src/mcp/types";

function spec(name = "exa"): McpServerSpec {
  return { name, url: `https://mcp.${name}.ai/mcp`, headers: {}, source: "project", filePath: "x" };
}

function toolInfo(server: string, name: string, overrides: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    name,
    toolName: `mcp_${server}_${name}`,
    description: "does a thing",
    inputSchema: {},
    ...overrides,
  };
}

function catalog(server: string, tools: readonly McpToolInfo[]): McpCatalog {
  return { server, fetchedAt: "2026-01-01T00:00:00.000Z", tools };
}

function entry(server: string, tools: readonly McpToolInfo[] | undefined): McpEntry {
  return { spec: spec(server), catalog: tools === undefined ? undefined : catalog(server, tools) };
}

function registryOf(entries: Record<string, McpEntry>): McpRegistry {
  return new Map(Object.entries(entries));
}




function run(
  tools: ToolSet,
  args: unknown,
  options: { abortSignal?: AbortSignal } = {},
): Promise<unknown> {
  const definition = tools[MCP_TOOL_NAME] as {
    execute: (args: unknown, options: unknown) => Promise<unknown>;
  };
  return definition.execute(args, { toolCallId: "t", messages: [], ...options });
}

function enumOptions(tools: ToolSet): readonly string[] {
  const definition = tools[MCP_TOOL_NAME] as unknown as {
    inputSchema: { shape: { tool: { options: string[] } } };
  };
  return definition.inputSchema.shape.tool.options;
}

describe("withMcp", () => {
  test("the ToolSet gains exactly one key for a registry of any size", () => {
    const tools = Array.from({ length: 30 }, (_, i) => toolInfo("exa", `tool_${i}`));
    const registry = registryOf({ exa: entry("exa", tools) });
    const composed = withMcp(
      {},
      registry,
      createMcpClients(async () => fakeHandle()),
    );
    expect(Object.keys(composed)).toEqual([MCP_TOOL_NAME]);
  });

  test("is absent entirely for a registry with no cataloged tools", () => {

    const registry = registryOf({ exa: entry("exa", undefined) });
    const tools = withMcp(
      {},
      registry,
      createMcpClients(async () => fakeHandle()),
    );
    expect(tools).toEqual({});
  });

  test("the enum contains every cataloged tool name and the description carries a line for each", () => {
    const registry = registryOf({
      exa: entry("exa", [toolInfo("exa", "web_search", { description: "Search the web." })]),
      notion: entry("notion", [
        toolInfo("notion", "search_pages", { description: "Search pages." }),
      ]),
    });
    const composed = withMcp(
      {},
      registry,
      createMcpClients(async () => fakeHandle()),
    );
    expect(enumOptions(composed).slice().sort()).toEqual([
      "mcp_exa_web_search",
      "mcp_notion_search_pages",
    ]);
    const description = (composed[MCP_TOOL_NAME] as { description: string }).description;
    expect(description).toContain("mcp_exa_web_search — Search the web.");
    expect(description).toContain("mcp_notion_search_pages — Search pages.");
  });

  test("the key order is stable across two builds from equivalently-ordered registries", () => {
    const build = () =>
      registryOf({
        exa: entry("exa", [toolInfo("exa", "web_search"), toolInfo("exa", "get_contents")]),
        notion: entry("notion", [toolInfo("notion", "search_pages")]),
      });
    const dial = async () => fakeHandle();
    const first = withMcp({}, build(), createMcpClients(dial));
    const second = withMcp({}, build(), createMcpClients(dial));
    expect(enumOptions(first)).toEqual(enumOptions(second));
    expect((first[MCP_TOOL_NAME] as { description: string }).description).toBe(
      (second[MCP_TOOL_NAME] as { description: string }).description,
    );
  });

  test("sorts by code unit, not by locale", () => {




    const registry = registryOf({
      x: entry("x", [
        toolInfo("x", "n1", { toolName: "mcp_a1" }),
        toolInfo("x", "n2", { toolName: "mcp_a_b" }),
        toolInfo("x", "n3", { toolName: "mcp_aa" }),
        toolInfo("x", "n4", { toolName: "mcp_ab" }),
      ]),
    });
    const composed = withMcp(
      {},
      registry,
      createMcpClients(async () => fakeHandle()),
    );
    expect(enumOptions(composed)).toEqual(["mcp_a1", "mcp_a_b", "mcp_aa", "mcp_ab"]);
  });

  test("execute forwards abortSignal and the remote (unprefixed) name", async () => {
    let captured: { name: string; args: Record<string, unknown>; signal?: AbortSignal } | undefined;
    const dial: DialFn = async () => ({
      listTools: async () => [],
      callTool: async (name, args, opts) => {
        captured = { name, args, signal: opts.signal };
        return "ok";
      },
      close: async () => {},
    });
    const registry = registryOf({
      exa: entry("exa", [toolInfo("exa", "web_search", { description: "Search the web." })]),
    });
    const clients = createMcpClients(dial);
    const composed = withMcp({}, registry, clients);
    const controller = new AbortController();

    const result = await run(
      composed,
      { tool: "mcp_exa_web_search", arguments: { query: "hi" } },
      { abortSignal: controller.signal },
    );

    expect(result).toBe("ok");
    expect(captured?.name).toBe("web_search");
    expect(captured?.args).toEqual({ query: "hi" });
    expect(captured?.signal).toBe(controller.signal);
  });

  test("throws a named error for a tool that is not in the registry", async () => {
    const registry = registryOf({
      exa: entry("exa", [toolInfo("exa", "web_search")]),
    });
    const composed = withMcp(
      {},
      registry,
      createMcpClients(async () => fakeHandle()),
    );
    await expect(run(composed, { tool: "mcp_notion_search_pages" })).rejects.toThrow(
      /mcp_notion_search_pages/,
    );
  });

  describe("argumentSummary, through the generated description", () => {
    test("renders required and optional params", () => {
      const registry = registryOf({
        exa: entry("exa", [
          toolInfo("exa", "web_search", {
            description: "Search the web and return contents.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" }, numResults: { type: "number" } },
              required: ["query"],
            },
          }),
        ]),
      });
      const composed = withMcp(
        {},
        registry,
        createMcpClients(async () => fakeHandle()),
      );
      const description = (composed[MCP_TOOL_NAME] as { description: string }).description;
      expect(description).toContain(
        "mcp_exa_web_search — Search the web and return contents. args: query (string, required), numResults (number)",
      );
    });

    test("a schema it cannot read costs one missing hint, not a throw", () => {
      const registry = registryOf({
        exa: entry("exa", [
          toolInfo("exa", "web_search", {
            description: "Search the web.",
            inputSchema: "not a schema",
          }),
        ]),
      });
      const composed = withMcp(
        {},
        registry,
        createMcpClients(async () => fakeHandle()),
      );
      const description = (composed[MCP_TOOL_NAME] as { description: string }).description;
      expect(description.trimEnd().endsWith("mcp_exa_web_search — Search the web.")).toBe(true);
      expect(description).not.toContain("args:");
    });
  });
});

function fakeHandle(): McpClientHandle {
  return {
    listTools: async () => [],
    callTool: async () => "",
    close: async () => {},
  };
}

describe("mcpCallSubject", () => {
  test("resolves a valid call to the inner mcp_* name", () => {
    expect(mcpCallSubject(MCP_TOOL_NAME, { tool: "mcp_exa_web_search", arguments: {} })).toBe(
      "mcp_exa_web_search",
    );
  });

  test("returns the tool name unchanged for a non-MCP tool", () => {
    expect(mcpCallSubject("bash", { command: "ls" })).toBe("bash");
  });

  test("falls back to 'mcp' for malformed or missing input.tool", () => {
    expect(mcpCallSubject(MCP_TOOL_NAME, {})).toBe(MCP_TOOL_NAME);
    expect(mcpCallSubject(MCP_TOOL_NAME, undefined)).toBe(MCP_TOOL_NAME);
    expect(mcpCallSubject(MCP_TOOL_NAME, { tool: 123 })).toBe(MCP_TOOL_NAME);
  });





  test("a built-in's name in input.tool never passes through as the subject", () => {
    expect(mcpCallSubject(MCP_TOOL_NAME, { tool: "read_file" })).toBe(MCP_TOOL_NAME);
    expect(mcpCallSubject(MCP_TOOL_NAME, { tool: "skill" })).toBe(MCP_TOOL_NAME);
  });
});
