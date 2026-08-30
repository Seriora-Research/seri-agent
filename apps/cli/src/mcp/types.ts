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

// The digest is truncated because this lands in a hand-editable YAML file that the store's own
// template invites people to comment and edit; 64 hex characters there is unreadable. 48 bits is
// ample against accidental collision, and the threat is a server changing its own tool, not one
// forging a digest.
const GRANT_DIGEST_LENGTH = 12;

// `.+` is greedy, so it consumes as much as it can before backtracking to satisfy the trailing
// `@<12 hex>`, which is what makes a `toolName` that itself happens to contain "@" resolve to the
// LAST such split rather than the first. Anchored at both ends so a value that merely contains a
// grant-shaped substring does not parse as one.
const GRANT_KEY_SHAPE = new RegExp(`^(${MCP_TOOL_PREFIX}.+)@([0-9a-f]{${GRANT_DIGEST_LENGTH}})$`);

export function mcpGrantKey(toolName: string, fingerprint: string): string {
  return `${toolName}@${fingerprint.slice(0, GRANT_DIGEST_LENGTH)}`;
}

// undefined for anything not shaped `mcp_<name>@<12 hex>` — that is how a built-in entry
// (`write_file`, `edit`) passes through a caller that tries this first and falls back to the bare
// name.
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

// Truncates currentFingerprint the same way mcpGrantKey truncated the one it stored, so the
// truncation rule is defined once and both sides of the comparison go through it.
export function mcpGrantMatches(entry: string, currentFingerprint: string): boolean {
  const parsed = parseMcpGrantKey(entry);
  if (parsed === undefined) return false;
  return parsed.fingerprint === currentFingerprint.slice(0, GRANT_DIGEST_LENGTH);
}
