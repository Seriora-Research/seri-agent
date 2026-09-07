import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { mcpAuthPath, saveMcpServerAuth } from "../../src/mcp/authStore";
import { createMcpClients, type McpServerStatus } from "../../src/mcp/client";
import {
  decideMcpCommand,
  mcpCommandAccepts,
  mcpLoginLine,
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
    expect(mcpCommandAccepts(["auth", "exa"])).toBe(true);
  });



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
    expect(mcpCommandAccepts(["auth"])).toBe(false);
    expect(mcpCommandAccepts(["auth", "exa", "extra"])).toBe(false);
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


    expect(lines.find((l) => l.includes("exa"))).toContain(
      "idle, connects on first use, 1 tool cached",
    );
    expect(lines.find((l) => l.includes("notion"))).toBe(
      "notion  user  idle, connects on first use",
    );
  });





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

    expect(readFileSync(projectFile, "utf8")).not.toContain("exa:");
  });




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
  test("edits the file the entry came from and deletes both its catalog and its credentials", () => {
    const { configDir, worktree } = load({
      "project/.seri/mcp/servers.yaml": "servers:\n  exa:\n    url: https://mcp.exa.ai/mcp\n",
    });

    const registry = loadMcpRegistry({ worktree, configDir, onWarning: () => {} });
    const entryFromRegistry = registry.get("exa");
    expect(entryFromRegistry).toBeDefined();

    writeCatalogCache(configDir, {
      server: "exa",
      fetchedAt: new Date().toISOString(),
      tools: [tool()],
    });
    saveMcpServerAuth(
      configDir,
      "exa",
      { tokens: { access_token: "at", token_type: "Bearer" } },
      "https://mcp.exa.ai/mcp",
    );
    expect(existsSync(join(configDir, "mcp", "catalog", "exa.json"))).toBe(true);
    expect(existsSync(mcpAuthPath(configDir, "exa"))).toBe(true);

    const { lines } = decideMcpCommand(["remove", "exa"], {
      registry,
      configDir,
      worktree,
      clients: createMcpClients(),
    });
    expect(lines).toEqual(['Removed "exa", its cached catalog and its stored credentials.']);

    const projectFile = entryFromRegistry?.spec.filePath as string;
    expect(readFileSync(projectFile, "utf8")).not.toContain("exa:");
    expect(existsSync(join(configDir, "mcp", "catalog", "exa.json"))).toBe(false);
    expect(existsSync(mcpAuthPath(configDir, "exa"))).toBe(false);
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

describe("one login outcome, worded once", () => {
  test("each ending gets its own line", () => {
    expect(mcpLoginLine("supabase", { status: "success" })).toBe(
      'Authenticated "supabase". Connect it from /mcp to preview and trust its tools.',
    );
    expect(mcpLoginLine("supabase", { status: "denied", message: "user denied" })).toBe(
      'Authenticating "supabase" was declined: user denied',
    );
    expect(mcpLoginLine("supabase", { status: "timeout" })).toBe(
      'Authenticating "supabase" timed out.',
    );
    expect(mcpLoginLine("supabase", { status: "aborted" })).toBe(
      'Authenticating "supabase" was cancelled.',
    );
  });




  test("an authorization server's own error is flattened to one bounded line", () => {
    const raw = [
      "HTTP 404: Invalid OAuth error response: [",
      "  {",
      '    "expected": "string",',
      '    "code": "invalid_type",',
      '    "path": [',
      '      "error"',
      "    ],",
      '    "message": "Invalid input: expected string, received undefined"',
      "  }",
      ']. Raw body: {"message":"Invalid or expired OAuth authorization"}',
    ].join("\n");
    const line = mcpLoginLine("supabase", { status: "error", message: raw });

    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(250);
    expect(line).toStartWith('Could not authenticate "supabase": HTTP 404:');
    expect(line).toEndWith("…");
  });

  test("a short error is passed through whole, with no ellipsis", () => {
    const line = mcpLoginLine("supabase", { status: "error", message: "connection refused" });
    expect(line).toBe('Could not authenticate "supabase": connection refused');
  });
});
