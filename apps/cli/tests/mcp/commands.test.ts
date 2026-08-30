import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createMcpClients, type McpServerStatus } from "../../src/mcp/client";
import {
  decideMcpCommand,
  mcpCommandAccepts,
  mcpPanelRows,
  mcpStatusWord,
} from "../../src/mcp/commands";
import { loadMcpRegistry, writeCatalogCache } from "../../src/mcp/registry";
import type { McpEntry, McpRegistry, McpToolInfo } from "../../src/mcp/types";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

// Same fixture shape as tests/mcp/registry.test.ts: the worktree sits below the tree root and the
// profile root is a sibling of the project, so the upward walk has something to walk and the two
// scopes stay on genuinely different files.
function makeTree(files: Record<string, string> = {}): { worktree: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), "seri-mcp-commands-"));
  roots.push(root);
  const worktree = join(root, "project", "packages", "cli");
  const configDir = join(root, "profile");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return { worktree, configDir };
}

function load(files: Record<string, string>): {
  registry: McpRegistry;
  configDir: string;
  worktree: string;
} {
  const { worktree, configDir } = makeTree(files);
  const registry = loadMcpRegistry({ worktree, configDir, onWarning: () => {} });
  return { registry, configDir, worktree };
}

function entry(overrides: Partial<McpEntry["spec"]> = {}, catalog?: McpEntry["catalog"]): McpEntry {
  return {
    spec: {
      name: "exa",
      url: "https://mcp.exa.ai/mcp",
      headers: {},
      source: "project",
      filePath: "x/servers.yaml",
      ...overrides,
    },
    catalog,
  };
}

function tool(overrides: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    name: "web_search",
    toolName: "mcp_exa_web_search",
    description: "Search the web.",
    inputSchema: {},
    ...overrides,
  };
}

describe("mcpCommandAccepts", () => {
  test("accepts every documented form", () => {
    expect(mcpCommandAccepts([])).toBe(true);
    expect(mcpCommandAccepts(["list"])).toBe(true);
    expect(mcpCommandAccepts(["add", "exa", "https://mcp.exa.ai/mcp"])).toBe(true);
    expect(mcpCommandAccepts(["remove", "exa"])).toBe(true);
    expect(mcpCommandAccepts(["connect", "exa"])).toBe(true);
  });

  // The exact hijack class SLASH_COMMANDS' own comment documents elsewhere: a task that merely
  // starts with "/mcp" must fall through to the model, not be swallowed by this command.
  test("does not accept a task that merely starts with /mcp", () => {
    expect(mcpCommandAccepts(["is", "broken,", "fix", "it"])).toBe(false);
  });

  test("rejects malformed forms", () => {
    expect(mcpCommandAccepts(["list", "extra"])).toBe(false);
    expect(mcpCommandAccepts(["add"])).toBe(false);
    expect(mcpCommandAccepts(["add", "exa"])).toBe(false);
    expect(mcpCommandAccepts(["add", "exa", "https://x", "extra"])).toBe(false);
    expect(mcpCommandAccepts(["remove"])).toBe(false);
    expect(mcpCommandAccepts(["remove", "exa", "extra"])).toBe(false);
    expect(mcpCommandAccepts(["connect"])).toBe(false);
    expect(mcpCommandAccepts(["bogus"])).toBe(false);
  });
});

describe("mcpPanelRows", () => {
  test("groups by scope with a header per group, project first", () => {
    const worktree = "/project";
    const registry: McpRegistry = new Map([
      ["notion", entry({ name: "notion", source: "user", filePath: "/profile/mcp/servers.yaml" })],
      [
        "exa",
        entry({ name: "exa", source: "project", filePath: "/project/.seri/mcp/servers.yaml" }),
      ],
    ]);
    const rows = mcpPanelRows(registry, createMcpClients(), worktree);
    expect(rows).toEqual([
      {
        kind: "header",
        scope: "project",
        sourceFile: relative(worktree, "/project/.seri/mcp/servers.yaml"),
      },
      {
        kind: "server",
        name: "exa",
        scope: "project",
        status: { state: "idle" },
        toolCount: undefined,
      },
      { kind: "header", scope: "user", sourceFile: "/profile/mcp/servers.yaml" },
      {
        kind: "server",
        name: "notion",
        scope: "user",
        status: { state: "idle" },
        toolCount: undefined,
      },
    ]);
  });

  // The precedent this mirrors: skillsPanelRows' own `where` field (src/skills/commands.ts:89) —
  // a project file is inside the tree the person is standing in, so its short relative form is
  // more useful than the full path; a profile-root file lives genuinely elsewhere and only its
  // absolute path helps. `makeTree`'s own fixture (this file's header comment) puts the worktree
  // and the profile root under two SIBLING directories, so the two forms are visibly different —
  // not, say, both collapsing to the same string by coincidence.
  test("a project-scope header renders worktree-relative, a user-scope header renders absolute", () => {
    const { registry, worktree } = load({
      "project/.seri/mcp/servers.yaml": "servers:\n  exa:\n    url: https://mcp.exa.ai/mcp\n",
      "profile/mcp/servers.yaml": "servers:\n  notion:\n    url: https://mcp.notion.com/mcp\n",
    });
    const projectEntry = registry.get("exa");
    const userEntry = registry.get("notion");
    if (projectEntry === undefined || userEntry === undefined) {
      throw new Error("fixture did not load both servers");
    }

    const rows = mcpPanelRows(registry, createMcpClients(), worktree);
    const headers = rows.filter((r) => r.kind === "header");
    const projectHeader = headers.find((h) => h.scope === "project");
    const userHeader = headers.find((h) => h.scope === "user");

    expect(projectHeader?.sourceFile).toBe(relative(worktree, projectEntry.spec.filePath));
    expect(projectHeader?.sourceFile).not.toBe(projectEntry.spec.filePath);
    expect(userHeader?.sourceFile).toBe(userEntry.spec.filePath);
  });

  test("a server never dialled reports idle with an undefined tool count", () => {
    const registry: McpRegistry = new Map([["exa", entry()]]);
    const rows = mcpPanelRows(registry, createMcpClients(), "w");
    const row = rows.find((r) => r.kind === "server");
    expect(row).toEqual({
      kind: "server",
      name: "exa",
      scope: "project",
      status: { state: "idle" },
      toolCount: undefined,
    });
  });

  test("a server with a cached catalog reports its tool count, and status follows the live clients", () => {
    const catalog = { server: "exa", fetchedAt: new Date().toISOString(), tools: [tool()] };
    const registry: McpRegistry = new Map([["exa", entry({}, catalog)]]);
    const clients = createMcpClients();
    clients.status.set("exa", { state: "connected", toolCount: 1 });

    const rows = mcpPanelRows(registry, clients, "w");
    const row = rows.find((r) => r.kind === "server");
    expect(row).toEqual({
      kind: "server",
      name: "exa",
      scope: "project",
      status: { state: "connected", toolCount: 1 },
      toolCount: 1,
    });
  });

  // Negative control (must be seen red before this passes): mcpPanelRows must reflect the SESSION's
  // frozen registry, never a fresh disk read. Proven by mutating servers.yaml on disk after the
  // registry is built and asserting the rows do not change. If mcpPanelRows read from disk instead
  // of the passed registry, this assertion would fail because the second server would appear.
  test("reflects the session's registry, not disk — a later edit to servers.yaml does not change the rows", () => {
    const { registry, worktree } = load({
      "project/.seri/mcp/servers.yaml": "servers:\n  exa:\n    url: https://mcp.exa.ai/mcp\n",
    });
    const before = mcpPanelRows(registry, createMcpClients(), worktree);

    const filePath = join(worktree, "..", "..", ".seri", "mcp", "servers.yaml");
    writeFileSync(
      filePath,
      "servers:\n  exa:\n    url: https://mcp.exa.ai/mcp\n  vercel:\n    url: https://mcp.vercel.com/mcp\n",
    );

    const after = mcpPanelRows(registry, createMcpClients(), worktree);
    expect(after).toEqual(before);
    expect(after.some((r) => r.kind === "server" && r.name === "vercel")).toBe(false);
  });
});

describe("decideMcpCommand: list", () => {
  test("an empty registry points at /mcp add", () => {
    const { lines } = decideMcpCommand(["list"], {
      registry: new Map(),
      configDir: "c",
      worktree: "w",
      clients: createMcpClients(),
    });
    expect(lines).toEqual(["No MCP servers configured. Add one with /mcp add <name> <url>."]);
  });

  test("one line per server, naming scope, live status, and the cached tool count", () => {
    const catalog = { server: "exa", fetchedAt: new Date().toISOString(), tools: [tool()] };
    const registry: McpRegistry = new Map([
      ["exa", entry({}, catalog)],
      ["notion", entry({ name: "notion", source: "user" })],
    ]);
    const { lines } = decideMcpCommand(["list"], {
      registry,
      configDir: "c",
      worktree: "w",
      clients: createMcpClients(),
    });
    expect(lines).toEqual([expect.stringContaining("exa"), expect.stringContaining("notion")]);
    // Neither server was dialled this session, so both read idle — but exa's cache from an earlier
    // session still names a tool count, and notion (never added) has none to show.
    expect(lines.find((l) => l.includes("exa"))).toContain(
      "idle, connects on first use, 1 tool cached",
    );
    expect(lines.find((l) => l.includes("notion"))).toBe(
      "notion  user  idle, connects on first use",
    );
  });

  // Seen red first by reverting listLines to derive status from `entry.catalog` alone (the shape
  // this line used before it took `clients`): a server this session dialled and found unreachable
  // read as though nothing had happened, "idle, connects on first use", identically to a server
  // never touched at all.
  test("a server whose pool status is failed reports unreachable, not idle", () => {
    const catalog = { server: "exa", fetchedAt: new Date().toISOString(), tools: [tool()] };
    const registry: McpRegistry = new Map([["exa", entry({}, catalog)]]);
    const clients = createMcpClients();
    clients.status.set("exa", { state: "failed", message: "connection refused" });

    const { lines } = decideMcpCommand(["list"], {
      registry,
      configDir: "c",
      worktree: "w",
      clients,
    });
    expect(lines[0]).toContain("unreachable");
    expect(lines[0]).not.toContain("idle");
  });

  test("a server whose pool status is needs-auth says so", () => {
    const registry: McpRegistry = new Map([["exa", entry()]]);
    const clients = createMcpClients();
    clients.status.set("exa", { state: "needs-auth" });

    const { lines } = decideMcpCommand(["list"], {
      registry,
      configDir: "c",
      worktree: "w",
      clients,
    });
    expect(lines[0]).toContain("needs authentication");
  });

  // The property worth pinning is agreement itself, not any one state's wording — so this walks
  // all four McpServerStatus states and checks both surfaces against the same expectation each
  // time, rather than duplicating one assertion per state.
  test("list and mcpPanelRows report the same status word for the same server, across all four states", () => {
    const catalog = { server: "exa", fetchedAt: new Date().toISOString(), tools: [tool()] };
    const registry: McpRegistry = new Map([["exa", entry({}, catalog)]]);
    const states: McpServerStatus[] = [
      { state: "idle" },
      { state: "connected", toolCount: 1 },
      { state: "needs-auth" },
      { state: "failed", message: "connection refused" },
    ];

    for (const status of states) {
      const clients = createMcpClients();
      if (status.state !== "idle") clients.status.set("exa", status);

      const { lines } = decideMcpCommand(["list"], {
        registry,
        configDir: "c",
        worktree: "w",
        clients,
      });
      const panelRow = mcpPanelRows(registry, clients, "w").find((r) => r.kind === "server");
      expect(panelRow?.kind).toBe("server");

      const word = mcpStatusWord(status);
      expect(lines[0]).toContain(word);
      expect(panelRow?.kind === "server" ? mcpStatusWord(panelRow.status) : undefined).toBe(word);
    }
  });
});

describe("decideMcpCommand: add", () => {
  test("writes the profile file, not a project file", () => {
    const { configDir, worktree } = makeTree({
      "project/.seri/mcp/servers.yaml": "servers:\n  other:\n    url: https://mcp.other.com/mcp\n",
    });
    const registry: McpRegistry = new Map();
    const { lines } = decideMcpCommand(["add", "exa", "https://mcp.exa.ai/mcp"], {
      registry,
      configDir,
      worktree,
      clients: createMcpClients(),
    });
    expect(lines[0]).toContain("Added");

    const profileFile = join(configDir, "mcp", "servers.yaml");
    const projectFile = join(worktree, "..", "..", ".seri", "mcp", "servers.yaml");
    expect(existsSync(profileFile)).toBe(true);
    expect(readFileSync(profileFile, "utf8")).toContain("exa:");
    // The project file that existed before the add is untouched.
    expect(readFileSync(projectFile, "utf8")).not.toContain("exa:");
  });

  // Negative control (must be seen red before this passes): if `/mcp add` wrote the project scope
  // instead of the profile root, this is the assertion that catches it — the entry would land in
  // the project file and the profile file would either not exist or lack the entry.
  test("negative control target: the profile file, specifically, is what add targets", () => {
    const { configDir } = makeTree({});
    const registry: McpRegistry = new Map();
    decideMcpCommand(["add", "exa", "https://mcp.exa.ai/mcp"], {
      registry,
      configDir,
      worktree: "w",
      clients: createMcpClients(),
    });
    const profileFile = join(configDir, "mcp", "servers.yaml");
    expect(existsSync(profileFile)).toBe(true);
    expect(readFileSync(profileFile, "utf8")).toContain("exa:");
  });

  test("rejects a non-https url without writing anything", () => {
    const { configDir } = makeTree({});
    const registry: McpRegistry = new Map();
    const { lines } = decideMcpCommand(["add", "exa", "http://mcp.exa.ai/mcp"], {
      registry,
      configDir,
      worktree: "w",
      clients: createMcpClients(),
    });
    expect(lines[0]).toContain("https");
    expect(existsSync(join(configDir, "mcp", "servers.yaml"))).toBe(false);
  });

  test("rejects a bad name without writing anything", () => {
    const { configDir } = makeTree({});
    const registry: McpRegistry = new Map();
    const { lines } = decideMcpCommand(["add", "Bad Name", "https://mcp.exa.ai/mcp"], {
      registry,
      configDir,
      worktree: "w",
      clients: createMcpClients(),
    });
    expect(lines[0]).toContain("name");
    expect(existsSync(join(configDir, "mcp", "servers.yaml"))).toBe(false);
  });

  test("a malformed target servers.yaml surfaces as a returned line, not a throw", () => {
    const { configDir } = makeTree({ "profile/mcp/servers.yaml": "servers:\n  exa: [unclosed\n" });
    const registry: McpRegistry = new Map();
    const { lines } = decideMcpCommand(["add", "vercel", "https://mcp.vercel.com/mcp"], {
      registry,
      configDir,
      worktree: "w",
      clients: createMcpClients(),
    });
    expect(lines[0]).toContain("not changed");
  });

  // The reported bug, at the seam that caused it: add wrote the file and returned nothing for the
  // session, so the very next /mcp read an unchanged registry and said no servers were configured.
  // Seen red by dropping `change` from addResult's success return.
  test("the session that ran add can see the server without restarting", () => {
    const { configDir, worktree } = makeTree({});
    const registry = new Map<string, McpEntry>();
    const deps = { registry, configDir, worktree, clients: createMcpClients() };

    const { change } = decideMcpCommand(["add", "exa", "https://mcp.exa.ai/mcp"], deps);
    expect(change).toEqual({ kind: "added", entry: expect.anything() });
    if (change?.kind === "added") registry.set(change.entry.spec.name, change.entry);

    expect(decideMcpCommand(["list"], deps).lines).toEqual([
      "exa  user  idle, connects on first use",
    ]);
    const rows = mcpPanelRows(registry, deps.clients, worktree);
    expect(rows.filter((row) => row.kind === "server").map((row) => row.name)).toEqual(["exa"]);
  });

  // Pins the claim addResult's own comment makes. If the two ever drift, a server would read one
  // way in the session that added it and another way after a restart, which is the class of bug
  // that made the panel worth trusting in the first place.
  test("the entry add hands back is the entry a restart would load from the file it wrote", () => {
    const { configDir, worktree } = makeTree({});
    const { change } = decideMcpCommand(["add", "exa", "https://mcp.exa.ai/mcp"], {
      registry: new Map(),
      configDir,
      worktree,
      clients: createMcpClients(),
    });
    const reloaded = loadMcpRegistry({ worktree, configDir, onWarning: () => {} }).get("exa");

    expect(reloaded).toBeDefined();
    expect(change?.kind === "added" ? change.entry.spec : undefined).toEqual(
      reloaded?.spec as McpEntry["spec"],
    );
  });

  // An added server contributes no tools until someone previews and trusts it, which is what lets
  // the entry join a running session at all — see McpRegistryChange's own comment.
  test("the added entry carries no catalog", () => {
    const { configDir, worktree } = makeTree({});
    const { change } = decideMcpCommand(["add", "exa", "https://mcp.exa.ai/mcp"], {
      registry: new Map(),
      configDir,
      worktree,
      clients: createMcpClients(),
    });
    expect(change?.kind === "added" ? change.entry.catalog : "not-added").toBeUndefined();
  });

  test("a rejected add changes nothing about the session", () => {
    const { configDir } = makeTree({});
    const { change } = decideMcpCommand(["add", "exa", "http://mcp.exa.ai/mcp"], {
      registry: new Map(),
      configDir,
      worktree: "w",
      clients: createMcpClients(),
    });
    expect(change).toBeUndefined();
  });
});

describe("decideMcpCommand: remove", () => {
  test("edits the file the entry actually came from and deletes its cached catalog", () => {
    const { configDir, worktree } = load({
      "project/.seri/mcp/servers.yaml": "servers:\n  exa:\n    url: https://mcp.exa.ai/mcp\n",
    });
    // Re-load through loadMcpRegistry so the registry's entry carries the real filePath.
    const registry = loadMcpRegistry({ worktree, configDir, onWarning: () => {} });
    const entryFromRegistry = registry.get("exa");
    expect(entryFromRegistry).toBeDefined();

    writeCatalogCache(configDir, {
      server: "exa",
      fetchedAt: new Date().toISOString(),
      tools: [tool()],
    });
    expect(existsSync(join(configDir, "mcp", "catalog", "exa.json"))).toBe(true);

    const { lines } = decideMcpCommand(["remove", "exa"], {
      registry,
      configDir,
      worktree,
      clients: createMcpClients(),
    });
    expect(lines[0]).toContain("Removed");

    const projectFile = entryFromRegistry?.spec.filePath as string;
    expect(readFileSync(projectFile, "utf8")).not.toContain("exa:");
    expect(existsSync(join(configDir, "mcp", "catalog", "exa.json"))).toBe(false);
  });

  test("an unknown name returns a line rather than throwing", () => {
    const { configDir, worktree } = makeTree({});
    const registry: McpRegistry = new Map();
    const { lines, change } = decideMcpCommand(["remove", "ghost"], {
      registry,
      configDir,
      worktree,
      clients: createMcpClients(),
    });
    expect(lines).toEqual(['No MCP server named "ghost".']);
    expect(change).toBeUndefined();
  });

  // The other half of the add fix. Once a session can see a server it added, it has to stop seeing
  // one it removed, or /mcp keeps offering a row whose file is already gone.
  test("the session that ran remove stops listing the server", () => {
    const { configDir, worktree } = load({
      "project/.seri/mcp/servers.yaml": "servers:\n  exa:\n    url: https://mcp.exa.ai/mcp\n",
    });
    const registry = loadMcpRegistry({ worktree, configDir, onWarning: () => {} });
    const deps = { registry, configDir, worktree, clients: createMcpClients() };

    const { change } = decideMcpCommand(["remove", "exa"], deps);
    expect(change).toEqual({ kind: "removed", name: "exa" });
    if (change?.kind === "removed") registry.delete(change.name);

    expect(decideMcpCommand(["list"], deps).lines).toEqual([
      "No MCP servers configured. Add one with /mcp add <name> <url>.",
    ]);
    expect(mcpPanelRows(registry, deps.clients, worktree)).toEqual([]);
  });
});
