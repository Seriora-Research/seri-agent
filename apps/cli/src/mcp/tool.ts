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

// Reads only `properties` and `required`, and only if they are shaped the way JSON Schema shapes
// them — the server's schema is carried verbatim and never validated (see McpToolInfo.inputSchema),
// so this must degrade to "" rather than throw on whatever a server actually sent.
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

/**
 * Composed only when the registry has at least one cataloged tool, which is what keeps the tool
 * absent for a user with no servers — and for a server that has never been previewed, since a
 * server with no cached catalog contributes nothing.
 */
export function withMcp(tools: ToolSet, registry: McpRegistry, clients: McpClients): ToolSet {
  // Sorted by code unit, not by locale: this is what makes the tool array byte-stable across two
  // machines, which is the actual guarantee, not just across two builds on one machine. Every
  // `toolName` is `mcp_` plus lowercase letters, digits and underscore (mcpToolName), so there is
  // no non-ASCII case a locale-aware comparator would need to serve. `localeCompare` follows the
  // runtime's default ICU collation, which weighs punctuation differently from code-unit order and
  // disagrees between locales too (measured: en-US and da-DK order the same eight names
  // differently) — so the same registry would compose a different tool array depending on the
  // machine's locale, which is precisely the instability this sort exists to remove.
  const catalogedTools = [...registry.values()]
    .flatMap((entry) => entry.catalog?.tools ?? [])
    .sort((a, b) => (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0));
  // Destructured rather than asserted, so `z.enum` gets the non-empty tuple it requires without a
  // cast: a registry with nothing cataloged cannot reach it at all.
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
          // A thrown tool error reaches the model as a tool result it reads in the same turn
          // (loop.ts), so a name the enum allowed but the registry no longer resolves — the
          // registry is frozen per session, so this should not happen — still gets a legible
          // answer rather than an unhandled rejection.
          throw new Error(`no MCP tool named "${args.tool}" is available this session`);
        }
        // The remote name (found.tool.name), never the composed one: the server has no idea its
        // catalog got a `mcp_<server>_` prefix.
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

// Pure and beside the schema it reads, so the two cannot drift. The model supplies this string —
// `input` is the raw, unvalidated stream payload (loop.ts) — so the invariant is that an `mcp`
// call's subject is either an MCP-shaped name or the umbrella key, NEVER anything else: a gate
// that trusted an arbitrary model-chosen string here could be handed a built-in's name (e.g.
// "read_file") and reason about read-only's read class using it, waving the call through a mode
// that is supposed to block MCP entirely. Falling back to MCP_TOOL_NAME is the safe answer for
// every shape that is not a real MCP name — `mcp` is not in the gate's read class, so an
// unrecognised shape is gated rather than waved through.
export function mcpCallSubject(toolName: string, input: unknown): string {
  if (toolName !== MCP_TOOL_NAME) return toolName;
  if (typeof input !== "object" || input === null) return MCP_TOOL_NAME;
  const inner = (input as Record<string, unknown>).tool;
  return typeof inner === "string" && isMcpToolName(inner) ? inner : MCP_TOOL_NAME;
}
