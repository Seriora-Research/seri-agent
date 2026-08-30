import { join, relative } from "node:path";
import { getMcpDir } from "../config/paths";
import { messageOf } from "../errors";
import type { ExtensionSource } from "../extensions/discovery";
import type { McpClients, McpServerStatus } from "./client";
import { mcpServerStatus } from "./client";
import {
  addServerToFile,
  deleteCatalogCache,
  NAME_SHAPE,
  removeServerFromFile,
  SERVERS_FILENAME,
} from "./registry";
import type { McpEntry, McpRegistry } from "./types";

// One row of the /mcp panel. Built by mcpPanelRows below from the SESSION's frozen registry, never
// a fresh disk read — see that function's own comment for why, which is the same reason
// skillsPanelRows (skills/commands.ts) gives.
export type McpPanelRow =
  | { readonly kind: "header"; readonly scope: ExtensionSource; readonly sourceFile: string }
  | {
      readonly kind: "server";
      readonly name: string;
      readonly scope: ExtensionSource;
      readonly status: McpServerStatus;
      readonly toolCount: number | undefined; // undefined until a catalog is cached
    };

// The argv gate cli.ts runs before dispatch, kept here so it is testable against the exact strings
// a user types — the same split skillsCommandAccepts and memoryCommandAccepts use. Arity and
// subcommand shape only: `add`/`remove`'s deeper validation (name shape, https) happens in
// decideMcpCommand and is reported as a line, not rejected here, the same division `/mcp add`'s own
// contract already draws between "not a form this command handles" and "a form it handles badly".
export function mcpCommandAccepts(args: string[]): boolean {
  const [sub, ...rest] = args;
  if (sub === undefined) return true; // bare: opens the panel
  if (sub === "list") return rest.length === 0;
  if (sub === "add") return rest.length === 2;
  if (sub === "remove") return rest.length === 1;
  if (sub === "connect") return rest.length === 1; // dials; handled by the panel, not this file
  return false;
}

function groupOrder(entries: readonly McpEntry[]): [ExtensionSource, McpEntry[]][] {
  const bySource = new Map<ExtensionSource, McpEntry[]>();
  for (const entry of entries) {
    const group = bySource.get(entry.spec.source);
    if (group === undefined) bySource.set(entry.spec.source, [entry]);
    else group.push(entry);
  }
  // Project first, matching the manage-panel mock in research-mcp.md — the opposite of
  // extensionScopes' own user-then-project insertion order, which exists to make a later
  // same-name project entry win the Map.set, not to fix a display order.
  const order: ExtensionSource[] = ["project", "user"];
  return order
    .map((source): [ExtensionSource, McpEntry[]] => [source, bySource.get(source) ?? []])
    .filter(([, group]) => group.length > 0);
}

// Plain words, never a glyph. WARNING_MARK / ERROR_MARK (tui/theme/theme.ts) are applied in TUI
// components (tui/ui/ErrorLine.tsx, tui/ui/WarningBox.tsx); a logic module under mcp/ reaching for
// one would pull a presentation dependency into code with nothing to render, the same layering
// skills/commands.ts already respects by importing only a type from the TUI, never a value.
// list and mcpPanelRows both go through this one function, which is what keeps the two surfaces
// describing the same server the same way.
export function mcpStatusWord(status: McpServerStatus): string {
  if (status.state === "connected") return "connected";
  if (status.state === "needs-auth") return "needs authentication";
  if (status.state === "failed") return "unreachable";
  return "idle, connects on first use";
}

/**
 * The panel's rows, built from the registry and client pool the SESSION actually loaded and
 * dialled — never a fresh disk read or a fresh dial. `PreparedRun.mcp` is frozen at session start,
 * so a server added or reconnected since then is not what this session can call yet; a panel that
 * re-read disk would list it anyway and a call to it would fail with nothing here to explain why.
 * This is the same contract skillsPanelRows (skills/commands.ts) states, for the same reason.
 *
 * A server with no cached catalog reports `toolCount: undefined` and `status: {state:"idle"}` —
 * the visible consequence of never dialling at session start (research-mcp.md §2): idle is a real
 * third state, not "broken" collapsed down to two.
 *
 * A header's `sourceFile` is worktree-relative for a project-scope file and absolute for a
 * user-scope one — the same rule skillsPanelRows' own `where` field states (skills/commands.ts):
 * a project file is inside the tree the person is standing in, where `.seri/mcp/servers.yaml` is
 * both shorter and more useful than the full path, while a profile-root file lives genuinely
 * elsewhere and only its absolute path helps.
 */
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
    // Sorted by code unit, the same locale-independent order withMcp (mcp/tool.ts) sorts tool
    // names by, so the panel's row order does not depend on the machine it renders on.
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

// Status comes from the live pool, the same as mcpPanelRows — a server dialled this session and
// refused authentication, or found unreachable, must read the same way on both surfaces, not as
// though nothing had happened because this line only ever looked at the frozen catalog. The tool
// count comes from the catalog regardless of live status: it is what the model can call this
// session (loaded at session start), which is a different fact from whether the server is
// answering right now, and a server can be idle this session with a real count cached from an
// earlier one.
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

function addLines(
  name: string | undefined,
  url: string | undefined,
  deps: { configDir: string },
): string[] {
  if (name === undefined || !NAME_SHAPE.test(name)) {
    return [
      `"${name ?? ""}" is not a valid server name: it must be lowercase letters, digits and ` +
        `"-", starting with a letter or digit.`,
    ];
  }
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return [`"${url ?? ""}" is not a valid URL.`];
  }
  if (parsed.protocol !== "https:") {
    return [`"${url}" must be an https URL.`];
  }

  // The profile root, never the project scope: `/mcp add` is a personal action, and a project
  // servers.yaml is committable — writing it here on someone's behalf would put a server they typed
  // in a terminal into a file they might not have meant to share.
  const filePath = join(getMcpDir(deps.configDir), SERVERS_FILENAME);
  try {
    addServerToFile(filePath, { name, url: url as string, headers: {} });
  } catch (err) {
    return [messageOf(err)];
  }
  return [`Added "${name}". Connect it from /mcp to preview and trust its tools.`];
}

function removeLines(
  name: string | undefined,
  deps: { registry: McpRegistry; configDir: string },
): string[] {
  if (name === undefined) return ["Usage: /mcp remove <name>"];
  const entry = deps.registry.get(name);
  if (entry === undefined) return [`No MCP server named "${name}".`];

  let removed: boolean;
  try {
    // The file this exact entry was loaded from, never a guessed scope — a server can live in
    // either servers.yaml, and editing the wrong one would silently fail to remove it.
    removed = removeServerFromFile(entry.spec.filePath, name);
  } catch (err) {
    return [messageOf(err)];
  }
  if (!removed) return [`No MCP server named "${name}".`];

  deleteCatalogCache(deps.configDir, name);
  return [`Removed "${name}" and its cached catalog.`];
}

// The one-shot forms: list, add, remove. `connect` belongs to the panel because it dials, and the
// bare form opens the panel too — neither reaches this function in practice; the default line
// below exists only as a defensive fallback if they ever do.
export function decideMcpCommand(
  args: string[],
  deps: { registry: McpRegistry; configDir: string; worktree: string; clients: McpClients },
): { lines: string[] } {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "list") {
    return { lines: listLines(deps.registry, deps.clients) };
  }
  if (sub === "add") return { lines: addLines(rest[0], rest[1], deps) };
  if (sub === "remove") return { lines: removeLines(rest[0], deps) };

  return { lines: ["Usage: /mcp [list] | add <name> <url> | remove <name>"] };
}
