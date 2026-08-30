import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthTokens,
} from "@ai-sdk/mcp";
import { atomicWriteFile } from "../atomicWriteFile";
import { getMcpDir } from "../config/paths";

// Everything auth() (@ai-sdk/mcp) asks an OAuthClientProvider to persist for one server, in one
// record. The three halves are saved at three separate moments of a single authorization — the
// dynamically registered client, then the authorization server's own metadata, then the tokens —
// which is the whole reason saveMcpServerAuth below merges rather than writes.
export type McpServerAuth = {
  // The URL these credentials were minted against. Stored, not derived, so loadMcpServerAuth can
  // compare it — see there.
  readonly serverUrl: string;
  readonly tokens?: OAuthTokens;
  readonly obtainedAt?: string; // ISO8601
  readonly clientInformation?: OAuthClientInformation;
  readonly authorizationServer?: OAuthAuthorizationServerInformation;
};

// A sibling of the catalog cache directory (mcp/registry.ts). One file per server, never one
// shared file: two servers' credentials have independent lifecycles, the same "independent
// lifecycles get independent files" rule auth/xaiAuthStore.ts states for its own.
export function mcpAuthPath(configDir: string, name: string): string {
  return join(getMcpDir(configDir), "auth", `${name}.json`);
}

// Disk. Total degrade, the loadXaiSubscription contract (auth/xaiAuthStore.ts): a missing,
// unreadable, unparseable or wrongly-shaped file all mean "not authenticated", which is the same
// state as no file at all.
//
// `serverUrl` is compared, never merely read back: repointing a name in servers.yaml at a
// different host must never send the old server's bearer token to the new one. A mismatch reads as
// no credentials, so the new host gets its own authorization instead of the previous host's token.
export function loadMcpServerAuth(
  configDir: string,
  name: string,
  serverUrl: string,
): McpServerAuth | undefined {
  const path = mcpAuthPath(configDir, name);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as McpServerAuth;
    if (record.serverUrl !== serverUrl) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

// Disk. Read-merge-write: saveClientInformation, saveAuthorizationServerInformation and saveTokens
// are three separate provider calls within one auth() run, so a plain write would erase whichever
// two came before it. Reads through loadMcpServerAuth, so a record left behind by a different URL
// is replaced wholesale rather than merged into.
export function saveMcpServerAuth(
  configDir: string,
  name: string,
  patch: Partial<Omit<McpServerAuth, "serverUrl">>,
  serverUrl: string,
): McpServerAuth {
  const current = loadMcpServerAuth(configDir, name, serverUrl);
  const merged: McpServerAuth = {
    ...current,
    ...patch,
    serverUrl,
    obtainedAt: patch.tokens === undefined ? current?.obtainedAt : new Date().toISOString(),
  };
  atomicWriteFile(mcpAuthPath(configDir, name), JSON.stringify(merged));
  return merged;
}

// Disk. Idempotent, the same shape deleteCatalogCache (mcp/registry.ts) has: a server with nothing
// stored is left exactly as it was. Local only — this revokes nothing at the authorization server,
// so whatever calls it must not tell the user their access was withdrawn upstream.
export function clearMcpServerAuth(configDir: string, name: string): void {
  const path = mcpAuthPath(configDir, name);
  if (existsSync(path)) unlinkSync(path);
}
