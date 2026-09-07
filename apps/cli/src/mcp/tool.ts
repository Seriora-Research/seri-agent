import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { callMcpTool, type McpClients } from "./client";
import { findMcpTool } from "./registry";
import { isMcpToolName, type McpRegistry, type McpToolInfo } from "./types";

export const MCP_TOOL_NAME = "mcp";

const DESCRIPTION_HEADER =
  `Call a tool on one of this session's configured MCP servers. Pass "tool" as the full name of ` +
  `the tool to call and "arguments" as the JSON object it expects; omit "arguments" for a tool ` +
  `that takes none. Every tool available this session is listed below, one per line, with what ` +
  `it does and — where the server's own schema says so — its arguments.`;




function argumentSummary(inputSchema: unknown): string {
  if (typeof inputSchema !== "object" || inputSchema === null) return "";
  const schema = inputSchema as Record<string, unknown>;
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return "";
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
  return Object.entries(properties as Record<string, unknown>)
    .map(([name, value]) => {
      const type =
        typeof value === "object" &&
        value !== null &&
        typeof (value as { type?: unknown }).type === "string"
          ? (value as { type: string }).type
          : "any";
      return required.includes(name) ? `${name} (${type}, required)` : `${name} (${type})`;
    })
    .join(", ");
}

function describeMcpTool(info: McpToolInfo): string {
  const args = argumentSummary(info.inputSchema);
  return args.length > 0
    ? `${info.toolName} — ${info.description} args: ${args}`
    : `${info.toolName} — ${info.description}`;
}


export function withMcp(tools: ToolSet, registry: McpRegistry, clients: McpClients): ToolSet {








  const catalogedTools = [...registry.values()]
    .flatMap((entry) => entry.catalog?.tools ?? [])
    .sort((a, b) => (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0));


  const [first, ...rest] = catalogedTools.map((info) => info.toolName);
  if (first === undefined) return tools;

  const description = `${DESCRIPTION_HEADER}\n${catalogedTools.map(describeMcpTool).join("\n")}`;

  return {
    ...tools,
    [MCP_TOOL_NAME]: tool({
      description,
      inputSchema: z.object({
        tool: z.enum([first, ...rest]),
        arguments: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (args, { abortSignal }) => {
        const found = findMcpTool(registry, args.tool);
        if (found === undefined) {




          throw new Error(`no MCP tool named "${args.tool}" is available this session`);
        }


        return callMcpTool(
          clients,
          found.entry.spec,
          found.tool.name,
          args.arguments ?? {},
          abortSignal,
        );
      },
    }),
  };
}









export function mcpCallSubject(toolName: string, input: unknown): string {
  if (toolName !== MCP_TOOL_NAME) return toolName;
  if (typeof input !== "object" || input === null) return MCP_TOOL_NAME;
  const inner = (input as Record<string, unknown>).tool;
  return typeof inner === "string" && isMcpToolName(inner) ? inner : MCP_TOOL_NAME;
}
