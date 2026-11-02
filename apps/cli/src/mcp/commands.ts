import { join, relative } from "node:path";
import { getMcpDir } from "../config/paths";
import { messageOf } from "../errors";
import type { ExtensionSource } from "../extensions/discovery";
import { truncate } from "../truncate";
import { clearMcpServerAuth } from "./authStore";
import type { McpServerStatus } from "./client";
import type { McpHost, McpServerSummary } from "./host";
import type { McpLoginResult } from "./login";
import {
  addServerToFile,
  deleteCatalogCache,
  NAME_SHAPE,
  removeServerFromFile,
  SERVERS_FILENAME,
} from "./registry";
import type { McpEntry } from "./types";

export type McpPanelRow =
  | { readonly kind: "header"; readonly scope: ExtensionSource; readonly sourceFile: string }
  | {
      readonly kind: "server";
      readonly name: string;
      readonly scope: ExtensionSource;
      readonly status: McpServerStatus;
      readonly toolCount: number | undefined;
      /** Remote names the server offers beyond the trust ledger. */
      readonly awaitingReview: number;
    };

export function mcpCommandAccepts(args: string[]): boolean {
  const [sub, ...rest] = args;
  if (sub === undefined) return true;
  if (sub === "list") return rest.length === 0;
  if (sub === "add") return rest.length === 2;
  if (sub === "remove") return rest.length === 1;
  if (sub === "connect") return rest.length === 1;
  if (sub === "auth") return rest.length === 1;
  return false;
}

function groupOrder(servers: readonly McpServerSummary[]): [ExtensionSource, McpServerSummary[]][] {
  const bySource = new Map<ExtensionSource, McpServerSummary[]>();
  for (const server of servers) {
    const group = bySource.get(server.spec.source);
    if (group === undefined) bySource.set(server.spec.source, [server]);
    else group.push(server);
  }

  const order: ExtensionSource[] = ["project", "user"];
  return order
    .map((source): [ExtensionSource, McpServerSummary[]] => [source, bySource.get(source) ?? []])
    .filter(([, group]) => group.length > 0);
}

export function mcpStatusWord(status: McpServerStatus): string {
  if (status.state === "connected") return "connected";
  if (status.state === "needs-auth") return "needs authentication";
  if (status.state === "failed") return "unreachable";
  return "idle, connects on first use";
}

export function mcpLoginLine(name: string, result: McpLoginResult): string {
  if (result.status === "success") {
    return `Authenticated "${name}". Connect it from /mcp to preview and trust its tools.`;
  }
  if (result.status === "denied") return `Authenticating "${name}" was declined: ${result.message}`;
  if (result.status === "timeout") return `Authenticating "${name}" timed out.`;
  if (result.status === "aborted") return `Authenticating "${name}" was cancelled.`;

  return `Could not authenticate "${name}": ${truncate(result.message.replace(/\s+/g, " "), 200)}`;
}

export function mcpPanelRows(host: McpHost, worktree: string): readonly McpPanelRow[] {
  const rows: McpPanelRow[] = [];
  for (const [scope, servers] of groupOrder(host.servers())) {
    const first = servers[0];
    if (first === undefined) continue;
    const sourceFile =
      scope === "project" ? relative(worktree, first.spec.filePath) : first.spec.filePath;
    rows.push({ kind: "header", scope, sourceFile });

    for (const server of [...servers].sort((a, b) =>
      a.spec.name < b.spec.name ? -1 : a.spec.name > b.spec.name ? 1 : 0,
    )) {
      rows.push({
        kind: "server",
        name: server.spec.name,
        scope,
        status: server.status,
        toolCount: server.trustedToolCount,
        awaitingReview: server.awaitingReview.length,
      });
    }
  }
  return rows;
}

export function mcpTrustWord(entry: McpEntry, status: McpServerStatus): string {
  if (entry.catalog === undefined && status.state === "idle") return "pending review";
  return mcpStatusWord(status);
}

function listWord(server: McpServerSummary): string {
  if (!server.trusted && server.status.state === "idle") return "pending review";
  return mcpStatusWord(server.status);
}

function listLines(servers: readonly McpServerSummary[]): string[] {
  if (servers.length === 0) {
    return ["No MCP servers configured. Add one with /mcp add <name> <url>."];
  }
  const lines: string[] = [];
  for (const [, group] of groupOrder(servers)) {
    for (const server of group) {
      const toolCount = server.trustedToolCount;
      const toolsPart =
        toolCount === undefined ? "" : `, ${toolCount} tool${toolCount === 1 ? "" : "s"} cached`;
      lines.push(`${server.spec.name}  ${server.spec.source}  ${listWord(server)}${toolsPart}`);
    }
  }
  return lines;
}

function addResult(
  name: string | undefined,
  url: string | undefined,
  deps: { configDir: string },
): { lines: string[]; wroteConfig: boolean } {
  if (name === undefined || !NAME_SHAPE.test(name)) {
    return {
      lines: [
        `"${name ?? ""}" is not a valid server name: it must be lowercase letters, digits and ` +
          `"-", starting with a letter or digit.`,
      ],
      wroteConfig: false,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return { lines: [`"${url ?? ""}" is not a valid URL.`], wroteConfig: false };
  }
  if (parsed.protocol !== "https:") {
    return { lines: [`"${url}" must be an https URL.`], wroteConfig: false };
  }

  const filePath = join(getMcpDir(deps.configDir), SERVERS_FILENAME);
  try {
    addServerToFile(filePath, { name, url: url as string, headers: {} });
  } catch (err) {
    return { lines: [messageOf(err)], wroteConfig: false };
  }

  return {
    lines: [`Added "${name}". Connect it from /mcp to preview and trust its tools.`],
    wroteConfig: true,
  };
}

function removeResult(
  name: string | undefined,
  deps: { host: McpHost; configDir: string },
): { lines: string[]; wroteConfig: boolean } {
  if (name === undefined) return { lines: ["Usage: /mcp remove <name>"], wroteConfig: false };
  const server = deps.host.servers().find((row) => row.spec.name === name);
  if (server === undefined)
    return { lines: [`No MCP server named "${name}".`], wroteConfig: false };

  let removed: boolean;
  try {
    removed = removeServerFromFile(server.spec.filePath, name);
  } catch (err) {
    return { lines: [messageOf(err)], wroteConfig: false };
  }
  if (!removed) return { lines: [`No MCP server named "${name}".`], wroteConfig: false };

  deleteCatalogCache(deps.configDir, name);
  clearMcpServerAuth(deps.configDir, name);
  return {
    lines: [`Removed "${name}", its cached catalog and its stored credentials.`],
    wroteConfig: true,
  };
}

export function decideMcpCommand(
  args: string[],
  deps: { host: McpHost; configDir: string; worktree: string },
): { lines: string[]; wroteConfig: boolean } {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "list") {
    return { lines: listLines(deps.host.servers()), wroteConfig: false };
  }
  if (sub === "add") return addResult(rest[0], rest[1], deps);
  if (sub === "remove") return removeResult(rest[0], deps);

  return {
    lines: ["Usage: /mcp [list] | add <name> <url> | auth <name> | remove <name>"],
    wroteConfig: false,
  };
}
