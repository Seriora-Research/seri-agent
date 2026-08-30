import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  addServerToFile,
  findMcpTool,
  grantFingerprint,
  loadMcpRegistry,
  parseServersFile,
  readCatalogCache,
  removeServerFromFile,
  toolFingerprint,
  writeCatalogCache,
} from "../../src/mcp/registry";
import type { McpCatalog, McpEntry, McpRegistry, McpToolInfo } from "../../src/mcp/types";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

// The worktree sits several directories below the tree root so the upward walk has something to
// walk, and the profile root is a sibling of the project rather than an ancestor of it — the same
// fixture shape skills/registry.test.ts uses.
function makeTree(files: Record<string, string>): { worktree: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), "seri-mcp-"));
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

function load(files: Record<string, string>): { registry: McpRegistry; warnings: string[] } {
  const { worktree, configDir } = makeTree(files);
  const warnings: string[] = [];
  const registry = loadMcpRegistry({
    worktree,
    configDir,
    onWarning: (message) => warnings.push(message),
  });
  return { registry, warnings };
}

const EXA = `servers:
  exa:
    url: https://mcp.exa.ai/mcp
`;

describe("loadMcpRegistry", () => {
  test("no mcp directory anywhere loads nothing and warns about nothing", () => {
    const { registry, warnings } = load({});
    expect(registry.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("finds a project server by walking up from the worktree", () => {
    const { registry } = load({ "project/.seri/mcp/servers.yaml": EXA });
    expect([...registry.keys()]).toEqual(["exa"]);
    expect(registry.get("exa")?.spec.source).toBe("project");
  });

  test("finds a global server under the profile root", () => {
    const { registry } = load({ "profile/mcp/servers.yaml": EXA });
    expect(registry.get("exa")?.spec.source).toBe("user");
  });

  test("a project server beats a global one of the same name", () => {
    const { registry } = load({
      "profile/mcp/servers.yaml": EXA,
      "project/.seri/mcp/servers.yaml": EXA.replace(
        "https://mcp.exa.ai/mcp",
        "https://mcp.exa.ai/project",
      ),
    });
    expect(registry.size).toBe(1);
    expect(registry.get("exa")?.spec.url).toBe("https://mcp.exa.ai/project");
    expect(registry.get("exa")?.spec.source).toBe("project");
  });

  // Negative control: a broken file must not take session start down with it, and the warning has
  // to name the file or the user cannot find what to fix. The other scope must still load.
  test("a malformed YAML file is skipped with a warning naming it, and the other scope still loads", () => {
    const { registry, warnings } = load({
      "profile/mcp/servers.yaml": "servers:\n  exa: [unclosed\n",
      "project/.seri/mcp/servers.yaml": EXA.replace("exa:", "vercel:").replace(
        "https://mcp.exa.ai/mcp",
        "https://mcp.vercel.com/mcp",
      ),
    });
    expect([...registry.keys()]).toEqual(["vercel"]);
    expect(warnings.some((w) => w.includes("profile") && w.includes("not valid YAML"))).toBe(true);
  });

  test("a bad server name is skipped with a warning while a sibling loads", () => {
    const { registry, warnings } = load({
      "project/.seri/mcp/servers.yaml": `servers:
  Bad-Name:
    url: https://mcp.exa.ai/mcp
  exa:
    url: https://mcp.exa.ai/mcp
`,
    });
    expect([...registry.keys()]).toEqual(["exa"]);
    expect(warnings.some((w) => w.includes("Bad-Name") && w.includes("name"))).toBe(true);
  });

  // Underscore specifically, because rejecting it is what keeps mcpToolName injective and this is
  // the only thing standing between the fold and a silent collision. `mcpToolName` turns "-" into
  // "_", so a server named `my_server` and one named `my-server` would compose the identical
  // `mcp_my_server_x`, and the second would shadow the first in findMcpTool's scan with nothing
  // reported. The accepted name shape is what makes that pair unrepresentable rather than handled,
  // so widening it is not the cosmetic change it looks like.
  test("an underscore in a server name is rejected, which is what keeps the tool-name fold injective", () => {
    const { registry, warnings } = load({
      "project/.seri/mcp/servers.yaml": `servers:
  my_server:
    url: https://mcp.exa.ai/mcp
  my-server:
    url: https://mcp.exa.ai/mcp
`,
    });
    expect([...registry.keys()]).toEqual(["my-server"]);
    expect(warnings.some((w) => w.includes("my_server") && w.includes("name"))).toBe(true);
  });

  test("a non-https url is skipped with a warning while a sibling loads", () => {
    const { registry, warnings } = load({
      "project/.seri/mcp/servers.yaml": `servers:
  insecure:
    url: http://mcp.exa.ai/mcp
  exa:
    url: https://mcp.exa.ai/mcp
`,
    });
    expect([...registry.keys()]).toEqual(["exa"]);
    expect(warnings.some((w) => w.includes("insecure") && w.includes("https"))).toBe(true);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the title names the literal config syntax under test, not an interpolation.
  test("an unset ${env:…} skips that one server with a warning while a sibling loads", () => {
    const { registry, warnings } = load({
      "project/.seri/mcp/servers.yaml": `servers:
  exa:
    url: https://mcp.exa.ai/mcp
    headers:
      Authorization: Bearer \${env:SERI_TEST_DEFINITELY_UNSET_VAR}
  vercel:
    url: https://mcp.vercel.com/mcp
`,
    });
    expect([...registry.keys()]).toEqual(["vercel"]);
    expect(
      warnings.some((w) => w.includes("exa") && w.includes("SERI_TEST_DEFINITELY_UNSET_VAR")),
    ).toBe(true);
  });

  // Negative control: session start must never fail over a config file, so this is asserted at
  // the module boundary a fetch or an async signature would break. Point loadMcpRegistry at a
  // configured but unreachable URL and assert it returns synchronously with the server present
  // and catalog undefined.
  test("performs no network I/O: an unreachable server loads synchronously with no catalog", () => {
    const { worktree, configDir } = makeTree({
      "project/.seri/mcp/servers.yaml": "servers:\n  ghost:\n    url: https://127.0.0.1:1/mcp\n",
    });
    const result = loadMcpRegistry({ worktree, configDir, onWarning: () => {} });
    expect(result instanceof Map).toBe(true);
    const entry = result.get("ghost");
    expect(entry).toBeDefined();
    expect(entry?.catalog).toBeUndefined();
  });
});

describe("parseServersFile: $(...) is never expanded", () => {
  test("a shell-looking value survives as a literal string", () => {
    const { specs, warnings } = parseServersFile({
      text: `servers:
  exa:
    url: https://mcp.exa.ai/mcp
    headers:
      X-Whoami: $(whoami)
`,
      filePath: "servers.yaml",
      source: "project",
      env: {},
    });
    expect(warnings).toEqual([]);
    expect(specs[0]?.headers["X-Whoami"]).toBe("$(whoami)");
  });
});

describe("findMcpTool", () => {
  const tool: McpToolInfo = {
    name: "web_search",
    toolName: "mcp_exa_web_search",
    description: "Search the web.",
    inputSchema: { type: "object" },
  };
  const entry: McpEntry = {
    spec: { name: "exa", url: "https://mcp.exa.ai/mcp", headers: {}, source: "project", filePath: "x" },
    catalog: { server: "exa", fetchedAt: new Date().toISOString(), tools: [tool] },
  };
  const registry: McpRegistry = new Map([["exa", entry]]);

  test("resolves a known composed name", () => {
    expect(findMcpTool(registry, "mcp_exa_web_search")).toEqual({ entry, tool });
  });

  test("returns undefined for an unknown name", () => {
    expect(findMcpTool(registry, "mcp_exa_not_a_tool")).toBeUndefined();
  });
});

describe("toolFingerprint", () => {
  function tool(overrides: Partial<McpToolInfo> = {}): McpToolInfo {
    return {
      name: "web_search",
      toolName: "mcp_exa_web_search",
      description: "Search the web.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      ...overrides,
    };
  }

  test("is stable across key reordering in inputSchema", () => {
    const a = tool({ inputSchema: { type: "object", properties: { query: { type: "string" } } } });
    const b = tool({ inputSchema: { properties: { query: { type: "string" } }, type: "object" } });
    expect(toolFingerprint(a)).toBe(toolFingerprint(b));
  });

  test("changes when the description changes", () => {
    const a = tool({ description: "Search the web." });
    const b = tool({ description: "Search the web, differently." });
    expect(toolFingerprint(a)).not.toBe(toolFingerprint(b));
  });
});

describe("grantFingerprint", () => {
  test("undefined for a name that is not a cataloged MCP tool", () => {
    const registry: McpRegistry = new Map();
    expect(grantFingerprint(registry, "mcp_exa_web_search")).toBeUndefined();
  });

  test("matches toolFingerprint for a resolved tool", () => {
    const tool: McpToolInfo = {
      name: "web_search",
      toolName: "mcp_exa_web_search",
      description: "Search the web.",
      inputSchema: {},
    };
    const registry: McpRegistry = new Map([
      [
        "exa",
        {
          spec: { name: "exa", url: "https://mcp.exa.ai/mcp", headers: {}, source: "project", filePath: "x" },
          catalog: { server: "exa", fetchedAt: new Date().toISOString(), tools: [tool] },
        },
      ],
    ]);
    expect(grantFingerprint(registry, "mcp_exa_web_search")).toBe(toolFingerprint(tool));
  });
});

describe("writeCatalogCache / readCatalogCache", () => {
  test("round-trips a catalog", () => {
    const { configDir } = makeTree({});
    const catalog: McpCatalog = {
      server: "exa",
      fetchedAt: new Date().toISOString(),
      tools: [
        { name: "web_search", toolName: "mcp_exa_web_search", description: "Search.", inputSchema: {} },
      ],
    };
    writeCatalogCache(configDir, catalog);
    const read = readCatalogCache(configDir, "exa", () => {});
    expect(read).toEqual(catalog);
  });

  test("a corrupt cache reads as undefined with a warning", () => {
    const { configDir } = makeTree({
      "profile/mcp/catalog/exa.json": "{ not valid json",
    });
    const warnings: string[] = [];
    const read = readCatalogCache(configDir, "exa", (m) => warnings.push(m));
    expect(read).toBeUndefined();
    expect(warnings.some((w) => w.includes("exa.json"))).toBe(true);
  });

  test("a missing cache reads as undefined with no warning", () => {
    const { configDir } = makeTree({});
    const warnings: string[] = [];
    const read = readCatalogCache(configDir, "nope", (m) => warnings.push(m));
    expect(read).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("addServerToFile / removeServerFromFile", () => {
  test("addServerToFile preserves a comment on an unrelated entry", () => {
    const { configDir } = makeTree({});
    const filePath = join(configDir, "mcp", "servers.yaml");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `servers:
  vercel: # do not touch, needs re-auth
    url: https://mcp.vercel.com/mcp
`,
    );

    addServerToFile(filePath, { name: "exa", url: "https://mcp.exa.ai/mcp", headers: {} });

    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("do not touch, needs re-auth");
    expect(text).toContain("vercel:");
    expect(text).toContain("exa:");
    expect(text).toContain("https://mcp.exa.ai/mcp");
  });

  test("removeServerFromFile returns false for an absent name", () => {
    const { configDir } = makeTree({});
    const filePath = join(configDir, "mcp", "servers.yaml");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, EXA);

    expect(removeServerFromFile(filePath, "not-there")).toBe(false);
    expect(readFileSync(filePath, "utf8")).toContain("exa:");
  });

  test("removeServerFromFile removes a present entry and returns true", () => {
    const { configDir } = makeTree({});
    const filePath = join(configDir, "mcp", "servers.yaml");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, EXA);

    expect(removeServerFromFile(filePath, "exa")).toBe(true);
    expect(readFileSync(filePath, "utf8")).not.toContain("exa:");
  });

  test("removeServerFromFile returns false when the file does not exist", () => {
    const { configDir } = makeTree({});
    const filePath = join(configDir, "mcp", "servers.yaml");
    expect(removeServerFromFile(filePath, "exa")).toBe(false);
  });
});
