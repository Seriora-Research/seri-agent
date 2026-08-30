// Zero runtime imports. `permissions/store.ts` must later import `isMcpToolName` from here, and
// `config/paths.ts` already imports `permissions/store.ts` — a runtime import here would close a
// cycle that `config/paths.ts`'s own header comment already documents having bitten this repo
// once (`bun run src/cli.ts --version` crashed at import time). The `ExtensionSource` import below
// is type-only, so it is erased before anything actually cycles at runtime.
import type { ExtensionSource } from "../extensions/discovery";

export const MCP_TOOL_PREFIX = "mcp_";

export type McpServerSpec = {
  readonly name: string; // ^[a-z0-9][a-z0-9-]*$
  readonly url: string; // https only
  readonly headers: Readonly<Record<string, string>>; // ${env:…} already expanded
  readonly source: ExtensionSource;
  readonly filePath: string;
};

export type McpToolInfo = {
  readonly name: string; // the remote name, unprefixed
  /**
   * The composed `mcp_<server>_<tool>` name, `-` folded to `_` in the server name. Computed
   * exactly ONCE, here, at catalog construction, and never parsed back out. The fold is lossy:
   * `mcp_my_server_x` reads equally well as server `my` with tool `server_x`, or server
   * `my-server` with tool `x`. Storing the composed name up front makes that ambiguity
   * unrepresentable instead of handled — `findMcpTool` (mcp/registry.ts) resolves a name by
   * scanning the frozen catalog for it, never by decomposing it. Write no inverse parser.
   */
  readonly toolName: string;
  readonly description: string;
  // The server's own JSON Schema, carried verbatim and never validated against — the server's own
  // InvalidParams response is the correction path for a malformed call. `unknown` rather than
  // JSONSchema7: nothing promises the wire produced a valid one, and narrowing it only in the one
  // function that reads it keeps a shape the wire never guaranteed from leaking downstream.
  readonly inputSchema: unknown;
};

export type McpCatalog = {
  readonly server: string;
  readonly fetchedAt: string; // ISO8601
  readonly tools: readonly McpToolInfo[];
};

export type McpEntry = { readonly spec: McpServerSpec; readonly catalog?: McpCatalog };
export type McpRegistry = ReadonlyMap<string, McpEntry>;

export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server.replaceAll("-", "_")}_${tool}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}
