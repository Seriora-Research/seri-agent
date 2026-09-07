import { join, relative } from "node:path";
import { getMcpDir } from "../config/paths";
import { messageOf } from "../errors";
import type { ExtensionSource } from "../extensions/discovery";
import { truncate } from "../truncate";
import { clearMcpServerAuth } from "./authStore";
import type { McpClients, McpServerStatus } from "./client";
import { mcpServerStatus } from "./client";
import type { McpLoginResult } from "./login";
import {
  addServerToFile,
  deleteCatalogCache,
  NAME_SHAPE,
  removeServerFromFile,
  SERVERS_FILENAME,
} from "./registry";
import type { McpEntry, McpRegistry } from "./types";




export type McpPanelRow =
  | { readonly kind: "header"; readonly scope: ExtensionSource; readonly sourceFile: string }
  | {
      readonly kind: "server";
      readonly name: string;
      readonly scope: ExtensionSource;
      readonly status: McpServerStatus;
      readonly toolCount: number | undefined;
    };


/** Session registry mutation from `/mcp add` or `/mcp remove`; `added` leaves the model tool array byte-identical when the entry has no cataloged tools. */
export type McpRegistryChange =
  | { readonly kind: "added"; readonly entry: McpEntry }
  | { readonly kind: "removed"; readonly name: string };






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

function groupOrder(entries: readonly McpEntry[]): [ExtensionSource, McpEntry[]][] {
  const bySource = new Map<ExtensionSource, McpEntry[]>();
  for (const entry of entries) {
    const group = bySource.get(entry.spec.source);
    if (group === undefined) bySource.set(entry.spec.source, [entry]);
    else group.push(entry);
  }



  const order: ExtensionSource[] = ["project", "user"];
  return order
    .map((source): [ExtensionSource, McpEntry[]] => [source, bySource.get(source) ?? []])
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


export function mcpPanelRows(
  registry: McpRegistry,
  clients: McpClients,
  worktree: string,
): readonly McpPanelRow[] {
  const rows: McpPanelRow[] = [];
  for (const [scope, entries] of groupOrder([...registry.values()])) {
    const first = entries[0];
    if (first === undefined) continue;
    const sourceFile =
      scope === "project" ? relative(worktree, first.spec.filePath) : first.spec.filePath;
    rows.push({ kind: "header", scope, sourceFile });


    for (const entry of [...entries].sort((a, b) =>
      a.spec.name < b.spec.name ? -1 : a.spec.name > b.spec.name ? 1 : 0,
    )) {
      rows.push({
        kind: "server",
        name: entry.spec.name,
        scope,
        status: mcpServerStatus(clients, entry.spec.name),
        toolCount: entry.catalog?.tools.length,
      });
    }
  }
  return rows;
}








function listLines(registry: McpRegistry, clients: McpClients): string[] {
  if (registry.size === 0) {
    return ["No MCP servers configured. Add one with /mcp add <name> <url>."];
  }
  const lines: string[] = [];
  for (const [scope, entries] of groupOrder([...registry.values()])) {
    for (const entry of entries) {
      const word = mcpStatusWord(mcpServerStatus(clients, entry.spec.name));
      const toolCount = entry.catalog?.tools.length;
      const toolsPart =
        toolCount === undefined ? "" : `, ${toolCount} tool${toolCount === 1 ? "" : "s"} cached`;
      lines.push(`${entry.spec.name}  ${scope}  ${word}${toolsPart}`);
    }
  }
  return lines;
}

function addResult(
  name: string | undefined,
  url: string | undefined,
  deps: { configDir: string },
): { lines: string[]; change?: McpRegistryChange } {
  if (name === undefined || !NAME_SHAPE.test(name)) {
    return {
      lines: [
        `"${name ?? ""}" is not a valid server name: it must be lowercase letters, digits and ` +
          `"-", starting with a letter or digit.`,
      ],
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return { lines: [`"${url ?? ""}" is not a valid URL.`] };
  }
  if (parsed.protocol !== "https:") {
    return { lines: [`"${url}" must be an https URL.`] };
  }




  const filePath = join(getMcpDir(deps.configDir), SERVERS_FILENAME);
  try {
    addServerToFile(filePath, { name, url: url as string, headers: {} });
  } catch (err) {
    return { lines: [messageOf(err)] };
  }



  return {
    lines: [`Added "${name}". Connect it from /mcp to preview and trust its tools.`],
    change: {
      kind: "added",
      entry: { spec: { name, url: url as string, headers: {}, source: "user", filePath } },
    },
  };
}

function removeResult(
  name: string | undefined,
  deps: { registry: McpRegistry; configDir: string },
): { lines: string[]; change?: McpRegistryChange } {
  if (name === undefined) return { lines: ["Usage: /mcp remove <name>"] };
  const entry = deps.registry.get(name);
  if (entry === undefined) return { lines: [`No MCP server named "${name}".`] };

  let removed: boolean;
  try {


    removed = removeServerFromFile(entry.spec.filePath, name);
  } catch (err) {
    return { lines: [messageOf(err)] };
  }
  if (!removed) return { lines: [`No MCP server named "${name}".`] };

  deleteCatalogCache(deps.configDir, name);


  clearMcpServerAuth(deps.configDir, name);
  return {
    lines: [`Removed "${name}", its cached catalog and its stored credentials.`],
    change: { kind: "removed", name },
  };
}





export function decideMcpCommand(
  args: string[],
  deps: { registry: McpRegistry; configDir: string; worktree: string; clients: McpClients },
): { lines: string[]; change?: McpRegistryChange } {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "list") {
    return { lines: listLines(deps.registry, deps.clients) };
  }
  if (sub === "add") return addResult(rest[0], rest[1], deps);
  if (sub === "remove") return removeResult(rest[0], deps);

  return { lines: ["Usage: /mcp [list] | add <name> <url> | auth <name> | remove <name>"] };
}
