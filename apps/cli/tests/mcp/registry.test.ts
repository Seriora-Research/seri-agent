import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { McpEndpoint } from "../../src/mcp/endpoint";
import {
  addServerToFile,
  findMcpTool,
  grantFingerprint,
  loadMcpRegistry,
  parseServersFile,
  pendingMcpNames,
  pendingMcpNotice,
  readCatalogCache,
  removeServerFromFile,
  serverIdentity,
  toolFingerprint,
  writeCatalogCache,
} from "../../src/mcp/registry";
import type { McpCatalog, McpEntry, McpRegistry, McpToolInfo } from "../../src/mcp/types";

function endpoint(raw: string): McpEndpoint {
  const parsed = McpEndpoint.tryParse(raw);
  if (parsed === undefined) throw new Error("expected the test url to parse");
  return parsed;
}

import { ToolSpawnEnv } from "../../src/tools/toolSpawnEnv";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

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
    env: ToolSpawnEnv.inherited,
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
    expect(registry.get("exa")?.spec.url.wireHref()).toBe("https://mcp.exa.ai/project");
    expect(registry.get("exa")?.spec.source).toBe("project");
  });

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

  test("a skipped http url does not print a query token", () => {
    const { registry, warnings } = load({
      "project/.seri/mcp/servers.yaml": `servers:
  insecure:
    url: "http://host/mcp?token=SECRET"
  exa:
    url: https://mcp.exa.ai/mcp
`,
    });
    expect([...registry.keys()]).toEqual(["exa"]);
    const warning = warnings.find((w) => w.includes("insecure"));
    expect(warning).toBeDefined();
    expect(warning ?? "").toContain("https");
    expect(warning ?? "").toContain("skipped");
    expect(warning ?? "").not.toContain("SECRET");
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

  test("a trusted project's new server has no catalog and is pending", () => {
    const { worktree, configDir } = makeTree({
      "project/.seri/mcp/servers.yaml": `servers:
  exa:
    url: https://mcp.exa.ai/mcp
  ghost:
    url: https://127.0.0.1:1/mcp
`,
    });
    writeCatalogCache(configDir, {
      server: "exa",
      identity: serverIdentity({ url: "https://mcp.exa.ai/mcp", headers: {} }),
      fetchedAt: new Date().toISOString(),
      tools: [
        {
          name: "web_search",
          toolName: "mcp_exa_web_search",
          description: "Search.",
          inputSchema: {},
        },
      ],
    });
    const warnings: string[] = [];
    const registry = loadMcpRegistry({
      worktree,
      configDir,
      onWarning: (message) => warnings.push(message),
    });
    expect(registry.get("exa")?.catalog?.tools).toHaveLength(1);
    expect(registry.get("ghost")?.catalog).toBeUndefined();
    expect(pendingMcpNames(registry)).toEqual(["ghost"]);
    expect(warnings).toEqual([]);
  });

  test("changing a trusted server's URL drops the catalog", () => {
    const { worktree, configDir } = makeTree({
      "project/.seri/mcp/servers.yaml": "servers:\n  exa:\n    url: https://evil.example/mcp\n",
    });
    writeCatalogCache(configDir, {
      server: "exa",
      identity: serverIdentity({ url: "https://mcp.exa.ai/mcp", headers: {} }),
      fetchedAt: new Date().toISOString(),
      tools: [
        {
          name: "web_search",
          toolName: "mcp_exa_web_search",
          description: "Search.",
          inputSchema: {},
        },
      ],
    });
    const warnings: string[] = [];
    const registry = loadMcpRegistry({
      worktree,
      configDir,
      onWarning: (message) => warnings.push(message),
    });
    expect(registry.get("exa")?.spec.url.wireHref()).toBe("https://evil.example/mcp");
    expect(registry.get("exa")?.catalog).toBeUndefined();
    expect(pendingMcpNames(registry)).toEqual(["exa"]);
    expect(warnings.some((w) => w.includes("exa") && w.includes("changed"))).toBe(true);
  });

  test("changing a trusted server's header drops the catalog", () => {
    const { worktree, configDir } = makeTree({
      "project/.seri/mcp/servers.yaml": `servers:
  exa:
    url: https://mcp.exa.ai/mcp
    headers:
      Authorization: Bearer other
`,
    });
    writeCatalogCache(configDir, {
      server: "exa",
      identity: serverIdentity({
        url: "https://mcp.exa.ai/mcp",
        headers: { Authorization: "Bearer original" },
      }),
      fetchedAt: new Date().toISOString(),
      tools: [
        {
          name: "web_search",
          toolName: "mcp_exa_web_search",
          description: "Search.",
          inputSchema: {},
        },
      ],
    });
    const registry = loadMcpRegistry({ worktree, configDir, onWarning: () => {} });
    expect(registry.get("exa")?.catalog).toBeUndefined();
  });

  test("a name-only cached catalog is not inherited", () => {
    const { worktree, configDir } = makeTree({
      "project/.seri/mcp/servers.yaml": EXA,
    });
    writeCatalogCache(configDir, {
      server: "exa",
      fetchedAt: new Date().toISOString(),
      tools: [
        {
          name: "web_search",
          toolName: "mcp_exa_web_search",
          description: "Search.",
          inputSchema: {},
        },
      ],
    });
    const warnings: string[] = [];
    const registry = loadMcpRegistry({
      worktree,
      configDir,
      onWarning: (message) => warnings.push(message),
    });
    expect(registry.get("exa")?.catalog).toBeUndefined();
    expect(warnings.some((w) => w.includes("not bound to a URL"))).toBe(true);
  });
});

describe("serverIdentity / pendingMcpNotice", () => {
  test("the same url and headers hash the same, header key order does not matter", () => {
    expect(serverIdentity({ url: "https://mcp.exa.ai/mcp", headers: { A: "1", B: "2" } })).toBe(
      serverIdentity({ url: "https://mcp.exa.ai/mcp", headers: { B: "2", A: "1" } }),
    );
    expect(serverIdentity({ url: "https://mcp.exa.ai/mcp", headers: {} })).not.toBe(
      serverIdentity({ url: "https://evil.example/mcp", headers: {} }),
    );
  });

  test("pendingMcpNotice names the servers and is absent when none are pending", () => {
    expect(pendingMcpNotice([])).toBeUndefined();
    expect(pendingMcpNotice(["ghost"])).toBe(
      "MCP servers pending review (ghost) were not started — /mcp to preview and trust them",
    );
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
      env: ToolSpawnEnv.exactly({}),
    });
    expect(warnings).toEqual([]);
    expect(specs[0]?.headers["X-Whoami"]).toBe("$(whoami)");
  });
});

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

const TOKEN_SERVER = [
  "servers:",
  "  probe:",
  "    url: https://mcp.probe.test/mcp",
  "    headers:",
  "      Authorization: Bearer ${env:SERI_TEST_MCP_TOKEN}",
  "",
].join("\n");

describe("MCP config expands from the turn env", () => {
  test("a header expands from the snapshot when process.env holds a different value", () => {
    const original = process.env.SERI_TEST_MCP_TOKEN;
    process.env.SERI_TEST_MCP_TOKEN = "a";
    try {
      const { worktree, configDir } = makeTree({
        "project/.seri/mcp/servers.yaml": TOKEN_SERVER,
      });
      const registry = loadMcpRegistry({
        worktree,
        configDir,
        env: ToolSpawnEnv.exactly({ SERI_TEST_MCP_TOKEN: "b" }),
        onWarning: () => {},
      });
      expect(registry.get("probe")?.spec.headers.Authorization).toBe("Bearer b");
    } finally {
      restoreEnv("SERI_TEST_MCP_TOKEN", original);
    }
  });

  test("a snapshot that omits the variable skips the server instead of reading process.env", () => {
    const original = process.env.SERI_TEST_MCP_TOKEN;
    process.env.SERI_TEST_MCP_TOKEN = "a";
    try {
      const { worktree, configDir } = makeTree({
        "project/.seri/mcp/servers.yaml": TOKEN_SERVER,
      });
      const warnings: string[] = [];
      const registry = loadMcpRegistry({
        worktree,
        configDir,
        env: ToolSpawnEnv.exactly({}),
        onWarning: (message) => warnings.push(message),
      });
      expect(registry.has("probe")).toBe(false);
      expect(warnings.some((warning) => warning.includes("SERI_TEST_MCP_TOKEN"))).toBe(true);
      expect(warnings.some((warning) => warning.includes("Bearer a"))).toBe(false);
    } finally {
      restoreEnv("SERI_TEST_MCP_TOKEN", original);
    }
  });

  test("inherited expands a header from process.env", () => {
    const original = process.env.SERI_TEST_MCP_TOKEN;
    process.env.SERI_TEST_MCP_TOKEN = "a";
    try {
      const { worktree, configDir } = makeTree({
        "project/.seri/mcp/servers.yaml": TOKEN_SERVER,
      });
      const registry = loadMcpRegistry({
        worktree,
        configDir,
        env: ToolSpawnEnv.inherited,
        onWarning: () => {},
      });
      expect(registry.get("probe")?.spec.headers.Authorization).toBe("Bearer a");
    } finally {
      restoreEnv("SERI_TEST_MCP_TOKEN", original);
    }
  });

  test("a host placeholder expands before the url is validated", () => {
    const original = process.env.SERI_TEST_MCP_HOST;
    process.env.SERI_TEST_MCP_HOST = "mcp.a.test";
    try {
      const { specs, warnings } = parseServersFile({
        text: ["servers:", "  probe:", "    url: https://${env:SERI_TEST_MCP_HOST}/mcp", ""].join(
          "\n",
        ),
        filePath: "servers.yaml",
        source: "project",
        env: ToolSpawnEnv.exactly({ SERI_TEST_MCP_HOST: "mcp.b.test" }),
      });
      expect(warnings).toEqual([]);
      expect(specs[0]?.url.wireHref()).toBe("https://mcp.b.test/mcp");
    } finally {
      restoreEnv("SERI_TEST_MCP_HOST", original);
    }
  });

  test("a path placeholder is stored expanded", () => {
    const original = process.env.SERI_TEST_MCP_TOKEN;
    process.env.SERI_TEST_MCP_TOKEN = "other";
    try {
      const { specs, warnings } = parseServersFile({
        text: [
          "servers:",
          "  probe:",
          "    url: https://mcp.x.ai/${env:SERI_TEST_MCP_TOKEN}/mcp",
          "",
        ].join("\n"),
        filePath: "servers.yaml",
        source: "project",
        env: ToolSpawnEnv.exactly({ SERI_TEST_MCP_TOKEN: "acme" }),
      });
      expect(warnings).toEqual([]);
      expect(specs[0]?.url.wireHref()).toBe("https://mcp.x.ai/acme/mcp");
    } finally {
      restoreEnv("SERI_TEST_MCP_TOKEN", original);
    }
  });

  test("an unset variable in the url skips that server", () => {
    const original = process.env.SERI_TEST_MCP_HOST;
    delete process.env.SERI_TEST_MCP_HOST;
    try {
      const { specs, warnings } = parseServersFile({
        text: ["servers:", "  probe:", "    url: https://${env:SERI_TEST_MCP_HOST}/mcp", ""].join(
          "\n",
        ),
        filePath: "servers.yaml",
        source: "project",
        env: ToolSpawnEnv.exactly({}),
      });
      expect(specs).toEqual([]);
      expect(
        warnings.some(
          (warning) =>
            warning.includes('"url"') &&
            warning.includes("unset") &&
            warning.includes("SERI_TEST_MCP_HOST"),
        ),
      ).toBe(true);
    } finally {
      restoreEnv("SERI_TEST_MCP_HOST", original);
    }
  });

  test("a url that expands to http is skipped and the warning quotes the template", () => {
    const original = process.env.SERI_TEST_MCP_HOST;
    process.env.SERI_TEST_MCP_HOST = "https://mcp.a.test/mcp";
    try {
      const { specs, warnings } = parseServersFile({
        text: ["servers:", "  probe:", "    url: ${env:SERI_TEST_MCP_HOST}", ""].join("\n"),
        filePath: "servers.yaml",
        source: "project",
        env: ToolSpawnEnv.exactly({ SERI_TEST_MCP_HOST: "http://leak.test/mcp" }),
      });
      expect(specs).toEqual([]);
      expect(
        warnings.some(
          (warning) =>
            warning.includes("${env:SERI_TEST_MCP_HOST}") &&
            warning.includes("https") &&
            !warning.includes("leak.test"),
        ),
      ).toBe(true);
    } finally {
      restoreEnv("SERI_TEST_MCP_HOST", original);
    }
  });

  test("a url with no placeholder is stored as written", () => {
    const { specs, warnings } = parseServersFile({
      text: ["servers:", "  exa:", "    url: https://mcp.exa.ai", ""].join("\n"),
      filePath: "servers.yaml",
      source: "project",
      env: ToolSpawnEnv.exactly({}),
    });
    expect(warnings).toEqual([]);
    expect(specs[0]?.url.wireHref()).toBe("https://mcp.exa.ai");
  });

  test("trust follows the expanded header of the snapshot that was trusted", () => {
    const original = process.env.SERI_TEST_MCP_TOKEN;
    process.env.SERI_TEST_MCP_TOKEN = "a";
    try {
      const { worktree, configDir } = makeTree({
        "project/.seri/mcp/servers.yaml": TOKEN_SERVER,
      });
      writeCatalogCache(configDir, {
        server: "probe",
        identity: serverIdentity({
          url: "https://mcp.probe.test/mcp",
          headers: { Authorization: "Bearer b" },
        }),
        fetchedAt: new Date().toISOString(),
        tools: [
          {
            name: "echo",
            toolName: "mcp_probe_echo",
            description: "Echo.",
            inputSchema: {},
          },
        ],
      });
      const attached = loadMcpRegistry({
        worktree,
        configDir,
        env: ToolSpawnEnv.exactly({ SERI_TEST_MCP_TOKEN: "b" }),
        onWarning: () => {},
      });
      expect(attached.get("probe")?.spec.headers.Authorization).toBe("Bearer b");
      expect(attached.get("probe")?.catalog?.tools).toHaveLength(1);

      const warnings: string[] = [];
      const pending = loadMcpRegistry({
        worktree,
        configDir,
        env: ToolSpawnEnv.exactly({ SERI_TEST_MCP_TOKEN: "c" }),
        onWarning: (message) => warnings.push(message),
      });
      expect(pending.get("probe")?.catalog).toBeUndefined();
      expect(pendingMcpNames(pending)).toEqual(["probe"]);
      expect(warnings.some((warning) => warning.includes("changed since it was trusted"))).toBe(
        true,
      );
    } finally {
      restoreEnv("SERI_TEST_MCP_TOKEN", original);
    }
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
    spec: {
      name: "exa",
      url: endpoint("https://mcp.exa.ai/mcp"),
      headers: {},
      source: "project",
      filePath: "x",
    },
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
          spec: {
            name: "exa",
            url: endpoint("https://mcp.exa.ai/mcp"),
            headers: {},
            source: "project",
            filePath: "x",
          },
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
        {
          name: "web_search",
          toolName: "mcp_exa_web_search",
          description: "Search.",
          inputSchema: {},
        },
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
