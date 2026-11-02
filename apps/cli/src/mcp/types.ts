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
  // sha256 of url+headers at the moment of /mcp trust. Missing on caches written before
  // identity existed; loadMcpRegistry treats those as unmatched rather than inheriting
  // a name-only grant across a later URL change.
  readonly identity?: string;
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

/**
 * A tool the model may call this turn. Membership requires a trusted catalog name.
 * Description and inputSchema come from the live listing when this process has listed,
 * and from the ledger until then.
 */
export type McpTrustedTool = McpToolInfo & {
  readonly server: string;
  /** `toolFingerprint` of the bytes exposed now; the digest a saved grant must carry. */
  readonly fingerprint: string;
};

export type McpGrantMatch = {
  /** Composed names whose saved grant carries the fingerprint exposed now. */
  readonly allowed: readonly string[];
  /** Composed names exposed now whose saved grant carries a different fingerprint. */
  readonly stale: readonly string[];
};

/**
 * Saved MCP grants that authorize a tool exposed now. A grant authorizes exactly the fingerprint
 * it was saved with, so a tool that is not exposed can never be authorized.
 */
export function matchMcpGrants(
  entries: readonly string[],
  tools: readonly McpTrustedTool[],
): McpGrantMatch {
  const byName = new Map(tools.map((tool) => [tool.toolName, tool.fingerprint]));
  const allowed: string[] = [];
  const stale: string[] = [];
  for (const entry of entries) {
    const parsed = parseMcpGrantKey(entry);
    if (parsed === undefined) continue;
    const fingerprint = byName.get(parsed.toolName);
    if (fingerprint === undefined) continue;
    if (mcpGrantMatches(entry, fingerprint)) allowed.push(parsed.toolName);
    else stale.push(parsed.toolName);
  }
  return { allowed, stale };
}

/** Session-start grants minus every MCP entry. MCP grants are matched per turn, never cached as bare names. */
export function withoutMcpGrants(entries: readonly string[]): string[] {
  return entries.filter((entry) => !isMcpToolName(entry));
}

/** The digest `rememberGrant` stores for an "always" answer: the fingerprint the turn exposed. */
export function grantFingerprint(
  tools: readonly McpTrustedTool[],
  toolName: string,
): string | undefined {
  return tools.find((tool) => tool.toolName === toolName)?.fingerprint;
}
