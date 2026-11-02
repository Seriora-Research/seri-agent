import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import type { McpTurn } from "../../src/mcp/host";
import { MCP_TOOL_NAME, mcpCallSubject, withMcp } from "../../src/mcp/tool";
import type { McpToolInfo, McpTrustedTool } from "../../src/mcp/types";

function toolInfo(
  server: string,
  name: string,
  overrides: Partial<McpToolInfo> = {},
): McpTrustedTool {
  const info: McpToolInfo = {
    name,
    toolName: `mcp_${server}_${name}`,
    description: "does a thing",
    inputSchema: {},
    ...overrides,
  };
  return { ...info, server, fingerprint: "fp" };
}

function turnOf(
  tools: readonly McpTrustedTool[],
  withdrawn: readonly string[] = [],
  call: McpTurn["call"] = async (toolName) => {
    throw new Error(`no MCP tool named "${toolName}" is available this session`);
  },
): McpTurn {
  return { tools, withdrawn, notices: [], call };
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
  test("the ToolSet gains exactly one key for a turn of any size", () => {
    const tools = Array.from({ length: 30 }, (_, i) => toolInfo("exa", `tool_${i}`));
    const composed = withMcp({}, turnOf(tools));
    expect(Object.keys(composed)).toEqual([MCP_TOOL_NAME]);
  });

  test("is absent entirely when the turn exposes nothing and withdrew nothing", () => {
    expect(withMcp({}, turnOf([]))).toEqual({});
  });

  test("keeps the mcp key when every exposed tool has been withdrawn", async () => {
    let called = "";
    const composed = withMcp(
      {},
      turnOf([], ["mcp_exa_web_search"], async (toolName) => {
        called = toolName;
        throw new Error(`MCP tool "${toolName}" was removed: server "exa" no longer offers it.`);
      }),
    );
    const description = (composed[MCP_TOOL_NAME] as { description: string }).description;
    expect(description).toContain("Removed this session (do not call):");
    expect(description).toContain("mcp_exa_web_search");
    await expect(run(composed, { tool: "mcp_exa_web_search" })).rejects.toThrow(
      /no longer offers it/,
    );
    expect(called).toBe("mcp_exa_web_search");
  });

  test("the enum contains every exposed tool name and the description carries a line for each", () => {
    const composed = withMcp(
      {},
      turnOf([
        toolInfo("exa", "web_search", { description: "Search the web." }),
        toolInfo("notion", "search_pages", { description: "Search pages." }),
      ]),
    );
    expect(enumOptions(composed).slice().sort()).toEqual([
      "mcp_exa_web_search",
      "mcp_notion_search_pages",
    ]);
    const description = (composed[MCP_TOOL_NAME] as { description: string }).description;
    expect(description).toContain("mcp_exa_web_search — Search the web.");
    expect(description).toContain("mcp_notion_search_pages — Search pages.");
  });

  test("the key order is the turn's order, stable across two builds", () => {
    const tools = [
      toolInfo("exa", "web_search"),
      toolInfo("exa", "get_contents"),
      toolInfo("notion", "search_pages"),
    ];
    const first = withMcp({}, turnOf(tools));
    const second = withMcp({}, turnOf(tools));
    expect(enumOptions(first)).toEqual(enumOptions(second));
    expect(enumOptions(first)).toEqual([
      "mcp_exa_web_search",
      "mcp_exa_get_contents",
      "mcp_notion_search_pages",
    ]);
    expect((first[MCP_TOOL_NAME] as { description: string }).description).toBe(
      (second[MCP_TOOL_NAME] as { description: string }).description,
    );
  });

  test("execute forwards the composed name, arguments, and abortSignal to the turn", async () => {
    let captured: { name: string; args: Record<string, unknown>; signal?: AbortSignal } | undefined;
    const composed = withMcp(
      {},
      turnOf([toolInfo("exa", "web_search")], [], async (toolName, args, signal) => {
        captured = { name: toolName, args, signal };
        return "ok";
      }),
    );
    const controller = new AbortController();

    const result = await run(
      composed,
      { tool: "mcp_exa_web_search", arguments: { query: "hi" } },
      { abortSignal: controller.signal },
    );

    expect(result).toBe("ok");
    expect(captured?.name).toBe("mcp_exa_web_search");
    expect(captured?.args).toEqual({ query: "hi" });
    expect(captured?.signal).toBe(controller.signal);
  });

  test("a rejection from the turn reaches the caller", async () => {
    const composed = withMcp({}, turnOf([toolInfo("exa", "web_search")]));
    await expect(run(composed, { tool: "mcp_notion_search_pages" })).rejects.toThrow(
      /mcp_notion_search_pages/,
    );
  });

  describe("argumentSummary, through the generated description", () => {
    test("renders required and optional params", () => {
      const composed = withMcp(
        {},
        turnOf([
          toolInfo("exa", "web_search", {
            description: "Search the web and return contents.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" }, numResults: { type: "number" } },
              required: ["query"],
            },
          }),
        ]),
      );
      const description = (composed[MCP_TOOL_NAME] as { description: string }).description;
      expect(description).toContain(
        "mcp_exa_web_search — Search the web and return contents. args: query (string, required), numResults (number)",
      );
    });

    test("a schema it cannot read costs one missing hint, not a throw", () => {
      const composed = withMcp(
        {},
        turnOf([
          toolInfo("exa", "web_search", {
            description: "Search the web.",
            inputSchema: "not a schema",
          }),
        ]),
      );
      const description = (composed[MCP_TOOL_NAME] as { description: string }).description;
      expect(description.trimEnd().endsWith("mcp_exa_web_search — Search the web.")).toBe(true);
      expect(description).not.toContain("args:");
    });
  });
});

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
