import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthTokens,
} from "@ai-sdk/mcp";
import { atomicWriteFile } from "../atomicWriteFile";
import { getMcpDir } from "../config/paths";





export type McpServerAuth = {


  readonly serverUrl: string;
  readonly tokens?: OAuthTokens;
  readonly obtainedAt?: string;
  readonly clientInformation?: OAuthClientInformation;
  readonly authorizationServer?: OAuthAuthorizationServerInformation;
};




export function mcpAuthPath(configDir: string, name: string): string {
  return join(getMcpDir(configDir), "auth", `${name}.json`);
}








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




export function clearMcpServerAuth(configDir: string, name: string): void {
  const path = mcpAuthPath(configDir, name);
  if (existsSync(path)) unlinkSync(path);
}
