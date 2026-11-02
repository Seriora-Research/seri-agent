import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import type { McpTurn } from "./host";
import { isMcpToolName, type McpToolInfo } from "./types";

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

export function withMcp(tools: ToolSet, turn: McpTurn): ToolSet {
  const [first, ...rest] = turn.tools.map((info) => info.toolName);
  if (first === undefined && turn.withdrawn.length === 0) return tools;

  const currentLines = turn.tools.map(describeMcpTool);
  const removedLines =
    turn.withdrawn.length === 0 ? [] : ["Removed this session (do not call):", ...turn.withdrawn];
  const description = `${DESCRIPTION_HEADER}\n${[...currentLines, ...removedLines].join("\n")}`;
  const toolField = first === undefined ? z.string() : z.enum([first, ...rest]);

  return {
    ...tools,
    [MCP_TOOL_NAME]: tool({
      description,
      inputSchema: z.object({
        tool: toolField,
        arguments: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: (args, { abortSignal }) => turn.call(args.tool, args.arguments ?? {}, abortSignal),
    }),
  };
}

export function mcpCallSubject(toolName: string, input: unknown): string {
  if (toolName !== MCP_TOOL_NAME) return toolName;
  if (typeof input !== "object" || input === null) return MCP_TOOL_NAME;
  const inner = (input as Record<string, unknown>).tool;
  return typeof inner === "string" && isMcpToolName(inner) ? inner : MCP_TOOL_NAME;
}
