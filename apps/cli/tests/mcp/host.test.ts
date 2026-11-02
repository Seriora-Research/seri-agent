import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import type { DialFn, RemoteTool } from "../../src/mcp/client";
import { toToolInfo } from "../../src/mcp/client";
import { createMcpHost, type McpHost, type McpStore } from "../../src/mcp/host";
import { serverIdentity, toolFingerprint } from "../../src/mcp/registry";
import { MCP_TOOL_NAME, withMcp } from "../../src/mcp/tool";
import {
  grantFingerprint,
  type McpCatalog,
  type McpEntry,
  type McpServerSpec,
  type McpToolInfo,
  matchMcpGrants,
  mcpGrantKey,
} from "../../src/mcp/types";

const EXA: McpServerSpec = {
  name: "exa",
  url: "https://mcp.exa.ai/mcp",
  headers: {},
  source: "user",
  filePath: "/cfg/mcp/servers.yaml",
};

const SEARCH_V1: RemoteTool = {
  name: "web_search",
  description: "Search the web.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const SEARCH_V1_REORDERED: RemoteTool = {
  name: "web_search",
  description: "Search the web.",
  inputSchema: { required: ["query"], properties: { query: { type: "string" } }, type: "object" },
};
const SEARCH_V2: RemoteTool = {
  ...SEARCH_V1,
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, region: { type: "string" } },
    required: ["query", "region"],
  },
};
const CONTENTS: RemoteTool = {
  name: "get_contents",
  description: "Fetch a page.",
  inputSchema: {},
};
const DELETE_ALL: RemoteTool = {
  name: "delete_all",
  description: "Delete everything.",
  inputSchema: {},
};

function fakeServer(initial: readonly RemoteTool[]) {
  let tools = initial;
  let nextList: (() => Promise<readonly RemoteTool[]>) | undefined;
  const stats = { dials: 0, lists: 0, calls: [] as string[] };
  const dial: DialFn = async () => {
    stats.dials++;
    return {
      listTools: async () => {
        stats.lists++;
        const override = nextList;
        nextList = undefined;
        return override === undefined ? tools : override();
      },
      callTool: async (name) => {
        stats.calls.push(name);
        return `ok:${name}`;
      },
      close: async () => {},
    };
  };
  return {
    dial,
    stats,
    set(next: readonly RemoteTool[]) {
      tools = next;
    },
    failNextList(message: string) {
      nextList = () => Promise.reject(new Error(message));
    },
    holdNextList(): (reply: readonly RemoteTool[]) => void {
      let release: ((reply: readonly RemoteTool[]) => void) | undefined;
      nextList = () => new Promise((resolve) => (release = resolve));
      return (reply) => release?.(reply);
    },
  };
}

function catalogOf(spec: McpServerSpec, tools: readonly RemoteTool[]): McpCatalog {
  return {
    server: spec.name,
    identity: serverIdentity(spec),
    fetchedAt: "2026-11-02T00:00:00.000Z",
    tools: tools.map((tool) => toToolInfo(spec.name, tool)),
  };
}

function memoryStore(spec: McpServerSpec, ledger: readonly RemoteTool[] | undefined) {
  const specs = new Map<string, McpServerSpec>([[spec.name, spec]]);
  const ledgers = new Map<string, McpCatalog>();
  let writes = 0;
  const store: McpStore = {
    load: () =>
      new Map(
        [...specs.values()].map((s): [string, McpEntry] => {
          const catalog = ledgers.get(s.name);
          const bound = catalog?.identity === serverIdentity(s) ? catalog : undefined;
          return [s.name, { spec: s, catalog: bound }];
        }),
      ),
    writeTrust: (catalog) => {
      writes++;
      ledgers.set(catalog.server, JSON.parse(JSON.stringify(catalog)) as McpCatalog);
    },
  };
  if (ledger !== undefined) store.writeTrust(catalogOf(spec, ledger));
  return {
    store,
    writes: () => writes,
    setSpec: (next: McpServerSpec) => specs.set(next.name, next),
    removeServer: (name: string) => specs.delete(name),
  };
}

function hostFor(
  server: ReturnType<typeof fakeServer>,
  store: McpStore,
  relistTimeoutMs?: number,
): McpHost {
  return createMcpHost({ store, dial: server.dial, onWarning: () => {}, relistTimeoutMs });
}

function names(tools: readonly { toolName: string }[]): string[] {
  return tools.map((tool) => tool.toolName);
}
function descriptionOf(tools: ToolSet): string {
  return (tools[MCP_TOOL_NAME] as { description: string }).description;
}

describe("a running session sees server tool-list changes from the next turn", () => {
  test("a trusted tool whose schema changed is offered next turn at the new schema, and the old grant does not match", async () => {
    const server = fakeServer([SEARCH_V1, CONTENTS]);
    const disk = memoryStore(EXA, [SEARCH_V1, CONTENTS]);
    const host = hostFor(server, disk.store);
    const seededWrites = disk.writes();
    const t1 = await host.beginTurn(undefined);
    await t1.call("mcp_exa_web_search", { query: "q" }, undefined);

    server.set([SEARCH_V2, CONTENTS]);
    const t2 = await host.beginTurn(undefined);
    const v1Grant = mcpGrantKey(
      "mcp_exa_web_search",
      toolFingerprint(toToolInfo("exa", SEARCH_V1)),
    );

    expect(names(t2.tools)).toEqual(["mcp_exa_get_contents", "mcp_exa_web_search"]);
    expect(descriptionOf(withMcp({}, t2))).toContain("region (string, required)");
    expect(descriptionOf(withMcp({}, t2))).toContain("mcp_exa_web_search");
    expect(t2.notices).toEqual([expect.stringContaining("updated web_search")]);
    expect(matchMcpGrants([v1Grant], t2.tools).allowed).toEqual([]);
    expect(matchMcpGrants([v1Grant], t2.tools).stale).toEqual(["mcp_exa_web_search"]);
    expect(disk.writes()).toBe(seededWrites);
    expect(await t2.call("mcp_exa_web_search", { query: "q", region: "eu" }, undefined)).toBe(
      "ok:web_search",
    );
    expect(server.stats.calls).toEqual(["web_search", "web_search"]);
  });

  test("trusting a preview that includes a new name puts it in the next turn, on the same connection", async () => {
    const server = fakeServer([SEARCH_V1, CONTENTS]);
    const host = hostFor(server, memoryStore(EXA, [SEARCH_V1, CONTENTS]).store);
    await (await host.beginTurn(undefined)).call("mcp_exa_web_search", { query: "q" }, undefined);
    server.set([SEARCH_V1, CONTENTS, DELETE_ALL]);
    await host.beginTurn(undefined);

    host.trust(catalogOf(EXA, [SEARCH_V1, CONTENTS, DELETE_ALL]));
    const t3 = await host.beginTurn(undefined);

    expect(names(t3.tools)).toContain("mcp_exa_delete_all");
    expect(await t3.call("mcp_exa_delete_all", {}, undefined)).toBe("ok:delete_all");
    expect(server.stats.dials).toBe(1);
  });

  test("a tool the server dropped leaves the next turn, and a call from history says removed", async () => {
    const server = fakeServer([SEARCH_V1, CONTENTS]);
    const host = hostFor(server, memoryStore(EXA, [SEARCH_V1, CONTENTS]).store);
    await (await host.beginTurn(undefined)).call("mcp_exa_get_contents", {}, undefined);

    server.set([SEARCH_V1]);
    const t2 = await host.beginTurn(undefined);

    expect(names(t2.tools)).toEqual(["mcp_exa_web_search"]);
    expect(t2.notices).toEqual([expect.stringContaining("no longer offers get_contents")]);
    await expect(t2.call("mcp_exa_get_contents", {}, undefined)).rejects.toThrow(
      'MCP tool "mcp_exa_get_contents" was removed: server "exa" no longer offers it.',
    );
    expect(server.stats.calls).toEqual(["get_contents"]);
  });

  test("the first dial's listing refuses a drifted tool for this frozen turn; siblings still run", async () => {
    const server = fakeServer([SEARCH_V2, CONTENTS]);
    const host = hostFor(server, memoryStore(EXA, [SEARCH_V1, CONTENTS]).store);
    const t1 = await host.beginTurn(undefined);
    expect(names(t1.tools)).toEqual(["mcp_exa_get_contents", "mcp_exa_web_search"]);

    await expect(t1.call("mcp_exa_web_search", { query: "q" }, undefined)).rejects.toThrow(
      /during this turn/,
    );
    expect(await t1.call("mcp_exa_get_contents", {}, undefined)).toBe("ok:get_contents");
    expect(server.stats.calls).toEqual(["get_contents"]);
    const t2 = await host.beginTurn(undefined);
    expect(descriptionOf(withMcp({}, t2))).toContain("region (string, required)");
    expect(await t2.call("mcp_exa_web_search", { query: "q", region: "eu" }, undefined)).toBe(
      "ok:web_search",
    );
  });

  test("a new tool on a trusted server is never exposed, and no saved grant can authorize it", async () => {
    const server = fakeServer([SEARCH_V1, CONTENTS, DELETE_ALL]);
    const host = hostFor(server, memoryStore(EXA, [SEARCH_V1, CONTENTS]).store);
    await (await host.beginTurn(undefined)).call("mcp_exa_web_search", { query: "q" }, undefined);
    const t2 = await host.beginTurn(undefined);

    expect(names(t2.tools)).not.toContain("mcp_exa_delete_all");
    expect(descriptionOf(withMcp({}, t2))).not.toContain("delete_all");
    expect(t2.notices).toEqual([expect.stringContaining("offers 1 new tool (delete_all)")]);
    expect(host.servers()[0]?.awaitingReview).toEqual(["delete_all"]);
    const forged = mcpGrantKey(
      "mcp_exa_delete_all",
      toolFingerprint(toToolInfo("exa", DELETE_ALL)),
    );
    expect(matchMcpGrants([forged], t2.tools).allowed).toEqual([]);
    await expect(t2.call("mcp_exa_delete_all", {}, undefined)).rejects.toThrow(
      'no MCP tool named "mcp_exa_delete_all" is available this session',
    );
    expect(server.stats.calls).not.toContain("delete_all");

    const t3 = await host.beginTurn(undefined);
    expect(t3.notices).toEqual([]);
    expect(names(t3.tools)).toEqual(names(t2.tools));
  });

  test("a saved grant authorizes only the fingerprint it was saved with", async () => {
    const server = fakeServer([SEARCH_V1, CONTENTS]);
    const host = hostFor(server, memoryStore(EXA, [SEARCH_V1, CONTENTS]).store);
    const v1Grant = mcpGrantKey(
      "mcp_exa_web_search",
      toolFingerprint(toToolInfo("exa", SEARCH_V1)),
    );
    const t1 = await host.beginTurn(undefined);
    expect(matchMcpGrants([v1Grant], t1.tools).allowed).toEqual(["mcp_exa_web_search"]);
    await t1.call("mcp_exa_web_search", { query: "q" }, undefined);

    server.set([SEARCH_V2, CONTENTS]);
    const t2 = await host.beginTurn(undefined);
    expect(matchMcpGrants([v1Grant], t2.tools)).toEqual({
      allowed: [],
      stale: ["mcp_exa_web_search"],
    });
    expect(grantFingerprint(t2.tools, "mcp_exa_web_search")).toBe(
      toolFingerprint(toToolInfo("exa", SEARCH_V2)),
    );
  });

  test("a failed relist keeps the last view, and the next call reconnects and re-lists", async () => {
    const server = fakeServer([SEARCH_V1, CONTENTS]);
    const host = hostFor(server, memoryStore(EXA, [SEARCH_V1, CONTENTS]).store);
    await (await host.beginTurn(undefined)).call("mcp_exa_web_search", { query: "q" }, undefined);

    server.failNextList("session not found");
    const t2 = await host.beginTurn(undefined);

    expect(names(t2.tools)).toEqual(["mcp_exa_get_contents", "mcp_exa_web_search"]);
    expect(t2.notices).toEqual([]);
    expect(host.servers()[0]?.status.state).toBe("failed");
    expect(await t2.call("mcp_exa_web_search", { query: "q" }, undefined)).toBe("ok:web_search");
    expect(server.stats.dials).toBe(2);
  });

  test("a slow listing that lands after a newer one does not bring back a dropped tool", async () => {
    const server = fakeServer([SEARCH_V1, CONTENTS]);
    const host = hostFor(server, memoryStore(EXA, [SEARCH_V1, CONTENTS]).store, 10);
    await (await host.beginTurn(undefined)).call("mcp_exa_web_search", { query: "q" }, undefined);
    const releaseStale = server.holdNextList();
    await host.beginTurn(undefined);

    server.set([SEARCH_V1]);
    await host.beginTurn(undefined);
    releaseStale([SEARCH_V1, CONTENTS]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(names(host.tools())).toEqual(["mcp_exa_web_search"]);
  });

  test("/mcp remove during a turn: a call to that server says the user removed it", async () => {
    const server = fakeServer([SEARCH_V1, CONTENTS]);
    const disk = memoryStore(EXA, [SEARCH_V1, CONTENTS]);
    const host = hostFor(server, disk.store);
    const t1 = await host.beginTurn(undefined);
    await t1.call("mcp_exa_web_search", { query: "q" }, undefined);

    disk.removeServer("exa");
    host.reload();

    await expect(t1.call("mcp_exa_get_contents", {}, undefined)).rejects.toThrow(
      'the user removed server "exa" from this session',
    );
  });

  test("a URL change in config withdraws the server next turn without dialing the new URL", async () => {
    const server = fakeServer([SEARCH_V1, CONTENTS]);
    const disk = memoryStore(EXA, [SEARCH_V1, CONTENTS]);
    const host = hostFor(server, disk.store);
    await (await host.beginTurn(undefined)).call("mcp_exa_web_search", { query: "q" }, undefined);

    disk.setSpec({ ...EXA, url: "https://mcp.elsewhere.example/mcp" });
    const t2 = await host.beginTurn(undefined);

    expect(t2.tools).toEqual([]);
    await expect(t2.call("mcp_exa_web_search", { query: "q" }, undefined)).rejects.toThrow(
      /changed its URL or headers/,
    );
    expect(server.stats.dials).toBe(1);
  });
});

describe("negative controls", () => {
  test("an unchanged server is re-listed each turn yet composes byte-identical tools with no notices", async () => {
    const server = fakeServer([SEARCH_V1, CONTENTS]);
    const host = hostFor(server, memoryStore(EXA, [SEARCH_V1, CONTENTS]).store);
    const t1 = await host.beginTurn(undefined);
    await t1.call("mcp_exa_web_search", { query: "q" }, undefined);
    const listsAfterDial = server.stats.lists;

    const t2 = await host.beginTurn(undefined);

    expect(server.stats.lists).toBe(listsAfterDial + 1);
    expect(descriptionOf(withMcp({}, t2))).toBe(descriptionOf(withMcp({}, t1)));
    expect(names(t2.tools)).toEqual(names(t1.tools));
    expect(t2.notices).toEqual([]);
  });

  test("a ledger that round-tripped through JSON matches a live listing with reordered schema keys", async () => {
    const server = fakeServer([SEARCH_V1_REORDERED, CONTENTS]);
    const host = hostFor(server, memoryStore(EXA, [SEARCH_V1, CONTENTS]).store);
    expect(
      await (await host.beginTurn(undefined)).call("mcp_exa_web_search", { query: "q" }, undefined),
    ).toBe("ok:web_search");
    const t2 = await host.beginTurn(undefined);
    expect(names(t2.tools)).toEqual(["mcp_exa_get_contents", "mcp_exa_web_search"]);
    expect(t2.notices).toEqual([]);
  });

  test("beginTurn never dials an idle server; the whole ledger stays exposed until first use", async () => {
    const server = fakeServer([SEARCH_V2]);
    const host = hostFor(server, memoryStore(EXA, [SEARCH_V1, CONTENTS]).store);
    await host.beginTurn(undefined);
    const t2 = await host.beginTurn(undefined);

    expect(server.stats.dials).toBe(0);
    expect(names(t2.tools)).toEqual(["mcp_exa_get_contents", "mcp_exa_web_search"]);
  });

  test("exposed names sort by code unit, so an underscore stays ahead of a letter", async () => {
    const remotes: RemoteTool[] = [
      { name: "n1", description: "", inputSchema: {} },
      { name: "n2", description: "", inputSchema: {} },
      { name: "n3", description: "", inputSchema: {} },
      { name: "n4", description: "", inputSchema: {} },
    ];
    const named: McpToolInfo[] = [
      { ...toToolInfo("exa", remotes[0] as RemoteTool), toolName: "mcp_a1" },
      { ...toToolInfo("exa", remotes[1] as RemoteTool), toolName: "mcp_a_b" },
      { ...toToolInfo("exa", remotes[2] as RemoteTool), toolName: "mcp_aa" },
      { ...toToolInfo("exa", remotes[3] as RemoteTool), toolName: "mcp_ab" },
    ];
    const catalog: McpCatalog = {
      server: EXA.name,
      identity: serverIdentity(EXA),
      fetchedAt: "2026-11-02T00:00:00.000Z",
      tools: named,
    };
    const store: McpStore = {
      load: () => new Map([[EXA.name, { spec: EXA, catalog }]]),
      writeTrust: () => {},
    };
    const host = createMcpHost({
      store,
      dial: async () => {
        throw new Error("not dialed");
      },
      onWarning: () => {},
    });
    const turn = await host.beginTurn(undefined);
    expect(names(turn.tools)).toEqual(["mcp_a1", "mcp_a_b", "mcp_aa", "mcp_ab"]);
  });
});
