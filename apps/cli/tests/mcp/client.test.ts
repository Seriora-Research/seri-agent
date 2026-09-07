import { describe, expect, test } from "bun:test";
import { UnauthorizedError } from "@ai-sdk/mcp";
import { McpLoginRequiredError } from "../../src/mcp/authProvider";
import {
  callMcpTool,
  closeMcpClients,
  createMcpClients,
  type DialFn,
  fetchCatalog,
  flattenContent,
  type McpClientHandle,
  mcpServerStatus,
} from "../../src/mcp/client";
import type { McpServerSpec } from "../../src/mcp/types";

function spec(name = "exa"): McpServerSpec {
  return { name, url: `https://mcp.${name}.ai/mcp`, headers: {}, source: "project", filePath: "x" };
}

function fakeHandle(overrides: Partial<McpClientHandle> = {}): McpClientHandle {
  return {
    listTools: async () => [{ name: "web_search", description: "Search.", inputSchema: {} }],
    callTool: async (name) => `called ${name}`,
    close: async () => {},
    ...overrides,
  };
}


describe("dial once, reuse for the session", () => {
  test("callMcpTool twice against one server dials once", async () => {
    let dialCount = 0;
    const dial: DialFn = async () => {
      dialCount++;
      return fakeHandle();
    };
    const clients = createMcpClients(dial);
    await callMcpTool(clients, spec(), "web_search", {});
    await callMcpTool(clients, spec(), "web_search", {});
    expect(dialCount).toBe(1);
  });

  test("two calls racing the first dial share one connection", async () => {
    let dialCount = 0;
    let resolveDial: ((handle: McpClientHandle) => void) | undefined;
    const dial: DialFn = () =>
      new Promise((resolve) => {
        dialCount++;
        resolveDial = resolve;
      });
    const clients = createMcpClients(dial);
    const p1 = callMcpTool(clients, spec(), "web_search", {});
    const p2 = callMcpTool(clients, spec(), "web_search", {});
    resolveDial?.(fakeHandle());
    await Promise.all([p1, p2]);
    expect(dialCount).toBe(1);
  });
});

describe("a failed dial is evicted", () => {
  test("the next call dials again rather than staying broken for the session", async () => {
    let dialCount = 0;
    const dial: DialFn = async () => {
      dialCount++;
      if (dialCount === 1) throw new Error("connection refused");
      return fakeHandle();
    };
    const clients = createMcpClients(dial);
    await expect(callMcpTool(clients, spec(), "web_search", {})).rejects.toThrow();
    await callMcpTool(clients, spec(), "web_search", {});
    expect(dialCount).toBe(2);
  });
});





async function expectRejectsPromptly(promise: Promise<unknown>, ms = 200): Promise<void> {
  let timedOut = false;
  const timer = new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error(`did not settle within ${ms}ms`));
    }, ms);
  });
  await expect(Promise.race([promise, timer])).rejects.toThrow();
  if (timedOut) throw new Error(`expected the call to reject within ${ms}ms; it never settled`);
}

describe("the signal reaches both the dial and the call", () => {
  test("aborting mid-dial rejects", async () => {
    const controller = new AbortController();
    const dial: DialFn = (_spec, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const clients = createMcpClients(dial);
    const promise = callMcpTool(clients, spec(), "web_search", {}, controller.signal);
    controller.abort();
    await expectRejectsPromptly(promise);
  });

  test("aborting mid-call rejects", async () => {
    const controller = new AbortController();
    const handle: McpClientHandle = {
      listTools: async () => [],



      callTool: (name, _args, opts) =>
        name === "prime"
          ? Promise.resolve("primed")
          : new Promise((_resolve, reject) => {
              opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
      close: async () => {},
    };
    const clients = createMcpClients(async () => handle);
    await callMcpTool(clients, spec(), "prime", {});
    const promise = callMcpTool(clients, spec(), "web_search", {}, controller.signal);




    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expectRejectsPromptly(promise);
  });
});

describe("callTool flattens content to a string", () => {
  test("joins the text of each part and renders a non-text part as [<type>]", () => {
    const text = flattenContent({
      content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
    });
    expect(text).toBe("a\n[image]\nb");
  });

  test("no content array flattens to an empty string", () => {
    expect(flattenContent({})).toBe("");
  });

  test("an oversized join is capped, keeps both ends, and omits the middle", () => {
    const text = flattenContent({
      content: [
        { type: "text", text: "A".repeat(100_000) },
        { type: "text", text: "B".repeat(100_000) },
      ],
    });
    expect(text.length).toBeLessThan(30_200);
    expect(text.startsWith("A".repeat(100))).toBe(true);
    expect(text.endsWith("B".repeat(100))).toBe(true);
    expect(text).toContain("characters omitted");
  });

  test("a join that lands exactly on 30000 characters stays whole", () => {
    const text = flattenContent({
      content: [{ type: "text", text: "x".repeat(30_000) }],
    });
    expect(text).toHaveLength(30_000);
    expect(text).not.toContain("characters omitted");
  });
});

describe("a dial that only needs a login says so", () => {


  test("callMcpTool names /mcp auth instead of reporting the server unreachable", async () => {
    for (const err of [new UnauthorizedError(), new McpLoginRequiredError("exa")]) {
      const clients = createMcpClients(async () => {
        throw err;
      });
      await expect(callMcpTool(clients, spec("exa"), "a", {})).rejects.toThrow(
        'MCP server "exa" needs authentication. Run /mcp auth exa.',
      );
    }
  });
});

describe("failures throw with the server and tool named", () => {
  test("a failed tool call names both", async () => {
    const handle: McpClientHandle = {
      listTools: async () => [],
      callTool: async () => {
        throw new Error("boom");
      },
      close: async () => {},
    };
    const clients = createMcpClients(async () => handle);
    await expect(callMcpTool(clients, spec("exa"), "web_search", {})).rejects.toThrow(/exa/);
    await expect(callMcpTool(clients, spec("exa"), "web_search", {})).rejects.toThrow(/web_search/);
  });
});

describe("mcpServerStatus", () => {
  test("idle for a server never dialled", () => {
    const clients = createMcpClients(async () => fakeHandle());
    expect(mcpServerStatus(clients, "exa")).toEqual({ state: "idle" });
  });

  test("connected with toolCount after a successful listTools", async () => {
    const handle = fakeHandle({
      listTools: async () => [
        { name: "a", inputSchema: {} },
        { name: "b", inputSchema: {} },
      ],
    });
    const clients = createMcpClients(async () => handle);
    await callMcpTool(clients, spec("exa"), "a", {});
    expect(mcpServerStatus(clients, "exa")).toEqual({ state: "connected", toolCount: 2 });
  });

  test("needs-auth when the dial rejects with UnauthorizedError", async () => {
    const clients = createMcpClients(async () => {
      throw new UnauthorizedError();
    });
    await expect(callMcpTool(clients, spec("exa"), "a", {})).rejects.toThrow();
    expect(mcpServerStatus(clients, "exa")).toEqual({ state: "needs-auth" });
  });




  test("needs-auth when the dial rejects with McpLoginRequiredError", async () => {
    const clients = createMcpClients(async () => {
      throw new McpLoginRequiredError("exa");
    });
    await expect(callMcpTool(clients, spec("exa"), "a", {})).rejects.toThrow();
    expect(mcpServerStatus(clients, "exa")).toEqual({ state: "needs-auth" });
  });

  test("failed with a message for any other dial rejection", async () => {
    const clients = createMcpClients(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(callMcpTool(clients, spec("exa"), "a", {})).rejects.toThrow();
    const status = mcpServerStatus(clients, "exa");
    expect(status.state).toBe("failed");
    if (status.state === "failed") expect(status.message).toContain("ECONNREFUSED");
  });
});

describe("fetchCatalog", () => {
  test("uses its own connection, closes it, and never touches the session pool", async () => {
    let previewClosed = false;
    const previewHandle: McpClientHandle = {
      listTools: async () => [
        { name: "web_search", description: "Search.", inputSchema: { type: "object" } },
      ],
      callTool: async () => "",
      close: async () => {
        previewClosed = true;
      },
    };
    let poolDialCount = 0;
    const clients = createMcpClients(async () => {
      poolDialCount++;
      return fakeHandle();
    });

    const catalog = await fetchCatalog(spec("exa"), undefined, async () => previewHandle);

    expect(previewClosed).toBe(true);
    expect(poolDialCount).toBe(0);
    expect(mcpServerStatus(clients, "exa")).toEqual({ state: "idle" });
    expect(catalog.server).toBe("exa");
    expect(typeof catalog.fetchedAt).toBe("string");
    expect(catalog.tools).toEqual([
      {
        name: "web_search",
        toolName: "mcp_exa_web_search",
        description: "Search.",
        inputSchema: { type: "object" },
      },
    ]);
  });

  test("closes the connection even when listTools fails", async () => {
    let closed = false;
    const handle: McpClientHandle = {
      listTools: async () => {
        throw new Error("boom");
      },
      callTool: async () => "",
      close: async () => {
        closed = true;
      },
    };
    await expect(fetchCatalog(spec("exa"), undefined, async () => handle)).rejects.toThrow();
    expect(closed).toBe(true);
  });
});

describe("closeMcpClients", () => {
  test("is synchronous, closes every dialled handle, and is idempotent", async () => {
    let closeCalls = 0;
    const handle = fakeHandle({
      close: async () => {
        closeCalls++;
      },
    });
    const clients = createMcpClients(async () => handle);
    await callMcpTool(clients, spec(), "web_search", {});

    const warnings: string[] = [];
    closeMcpClients(clients, (m) => warnings.push(m));
    expect(clients.handles.size).toBe(0);



    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeCalls).toBe(1);
    expect(warnings).toEqual([]);

    closeMcpClients(clients, (m) => warnings.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeCalls).toBe(1);
  });

  test("a close failure is reported via onWarning, naming the server, rather than thrown", async () => {
    const handle = fakeHandle({
      close: async () => {
        throw new Error("stuck");
      },
    });
    const clients = createMcpClients(async () => handle);
    await callMcpTool(clients, spec("exa"), "web_search", {});

    const warnings: string[] = [];
    expect(() => closeMcpClients(clients, (m) => warnings.push(m))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnings.some((w) => w.includes("exa") && w.includes("stuck"))).toBe(true);
  });
});
