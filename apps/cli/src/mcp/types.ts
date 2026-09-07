




// Type-only imports only: a runtime import here would cycle with permissions/store.ts → config/paths.ts.
import type { ExtensionSource } from "../extensions/discovery";

export const MCP_TOOL_PREFIX = "mcp_";

export type McpServerSpec = {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly source: ExtensionSource;
  readonly filePath: string;
};

export type McpToolInfo = {
  readonly name: string;

  readonly toolName: string;
  readonly description: string;




  readonly inputSchema: unknown;
};

export type McpCatalog = {
  readonly server: string;
  readonly fetchedAt: string;
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





const GRANT_DIGEST_LENGTH = 12;





const GRANT_KEY_SHAPE = new RegExp(`^(${MCP_TOOL_PREFIX}.+)@([0-9a-f]{${GRANT_DIGEST_LENGTH}})$`);

export function mcpGrantKey(toolName: string, fingerprint: string): string {
  return `${toolName}@${fingerprint.slice(0, GRANT_DIGEST_LENGTH)}`;
}




export function parseMcpGrantKey(
  entry: string,
): { toolName: string; fingerprint: string } | undefined {
  const match = GRANT_KEY_SHAPE.exec(entry);
  if (match === null) return undefined;
  return { toolName: match[1] as string, fingerprint: match[2] as string };
}

export function isMcpGrantKey(entry: string): boolean {
  return parseMcpGrantKey(entry) !== undefined;
}



export function mcpGrantMatches(entry: string, currentFingerprint: string): boolean {
  const parsed = parseMcpGrantKey(entry);
  if (parsed === undefined) return false;
  return parsed.fingerprint === currentFingerprint.slice(0, GRANT_DIGEST_LENGTH);
}
