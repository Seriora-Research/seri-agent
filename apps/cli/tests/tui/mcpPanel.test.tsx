/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";
import type { McpPanelRow } from "../../src/mcp/commands";
import type { McpCatalog } from "../../src/mcp/types";
import { McpPanel } from "../../src/tui/routes/mcp/McpPanel";

const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  mountedRenderers.push(setup);
  createRoot(setup.renderer).render(node);
  await settle(setup);
  await settle(setup);
}

function header(scope: "project" | "user", sourceFile: string): McpPanelRow {
  return { kind: "header", scope, sourceFile };
}

function server(name: string, scope: "project" | "user" = "project"): McpPanelRow {
  return { kind: "server", name, scope, status: { state: "idle" }, toolCount: undefined };
}

const rows: McpPanelRow[] = [
  header("project", ".seri/mcp/servers.yaml"),
  server("exa"),
  server("vercel"),
];

function catalog(name: string): McpCatalog {
  return {
    server: name,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    tools: [
      {
        name: "web_search",
        toolName: `mcp_${name}_web_search`,
        description: "Search the web.",
        inputSchema: {},
      },
    ],
  };
}

describe("McpPanel", () => {
  test("renders every server row's formatted label", async () => {
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(setup, <McpPanel rows={rows} />);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("exa");
    expect(frame).toContain("vercel");
  });

  test("arrow navigation skips header rows", async () => {
    let removed: string | undefined;
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(
      setup,
      <McpPanel
        rows={rows}
        onRemove={(name) => {
          removed = name;
        }}
      />,
    );

    // Two selectable rows: two Downs must still land on vercel; a selectable header would walk past the end and drop the keypress.
    setup.mockInput.pressArrow("down");
    await settle(setup);
    setup.mockInput.pressArrow("down");
    await settle(setup);
    setup.mockInput.typeText("r");
    await settle(setup);

    expect(removed).toBe("vercel");
  });

  test("Esc closes the panel", async () => {
    let closed = false;
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(
      setup,
      <McpPanel
        rows={rows}
        onMcpClose={() => {
          closed = true;
        }}
      />,
    );

    setup.mockInput.pressEscape();
    // OpenTUI holds a bare ESC for a ~20ms disambiguation window before emitting it as escape.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle(setup);

    expect(closed).toBe(true);
  });

  test("Enter dials the highlighted server, showing static busy text while connecting", async () => {
    let resolveDial: (() => void) | undefined;
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(
      setup,
      <McpPanel
        rows={rows}
        onConnect={(name) =>
          new Promise((resolve) => {
            resolveDial = () => resolve({ ok: true, catalog: catalog(name) });
          })
        }
      />,
    );

    setup.mockInput.pressEnter();
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("Connecting…");

    resolveDial?.();
    await settle(setup);
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("web_search");
    expect(frame).toContain("1 tool");
  });

  test("a failed dial shows the error and returns to list mode", async () => {
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(
      setup,
      <McpPanel rows={rows} onConnect={async () => ({ ok: false, message: "ECONNREFUSED" })} />,
    );

    setup.mockInput.pressEnter();
    await settle(setup);
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("ECONNREFUSED");
    expect(frame).toContain("MCP servers");
  });

  test("the preview's y trusts the catalog, writes it, and returns to list mode", async () => {
    let trusted: McpCatalog | undefined;
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(
      setup,
      <McpPanel
        rows={rows}
        onConnect={async (name) => ({ ok: true, catalog: catalog(name) })}
        onTrust={(c) => {
          trusted = c;
        }}
      />,
    );

    setup.mockInput.pressEnter();
    await settle(setup);
    await settle(setup);
    setup.mockInput.typeText("y");
    await settle(setup);

    expect(trusted?.server).toBe("exa");
    expect(setup.captureCharFrame()).toContain("MCP servers");
  });

  test("a authenticates the highlighted server, showing static busy text while it waits", async () => {
    let authed: string | undefined;
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(
      setup,
      <McpPanel
        rows={rows}
        onAuth={(name) => {
          authed = name;
          return new Promise(() => {});
        }}
      />,
    );

    expect(setup.captureCharFrame()).toContain("a authenticate");
    setup.mockInput.typeText("a");
    await settle(setup);

    expect(authed).toBe("exa");
    expect(setup.captureCharFrame()).toContain("Waiting for your browser");
  });

  test("a successful login falls straight into the trust preview", async () => {
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(
      setup,
      <McpPanel
        rows={rows}
        onAuth={async () => ({ status: "success" })}
        onConnect={async (name) => ({ ok: true, catalog: catalog(name) })}
      />,
    );

    setup.mockInput.typeText("a");
    await settle(setup);
    await settle(setup);
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("web_search");
    expect(frame).toContain("Trust");
  });

  test("a login that did not succeed returns to list mode with the reason", async () => {
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(setup, <McpPanel rows={rows} onAuth={async () => ({ status: "timeout" })} />);

    setup.mockInput.typeText("a");
    await settle(setup);
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("timed out");
    expect(frame).toContain("MCP servers");
  });

  test("Esc while authenticating cancels the login rather than closing the panel", async () => {
    let cancelled = false;
    let closed = false;
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(
      setup,
      <McpPanel
        rows={rows}
        onAuth={() => new Promise(() => {})}
        onAuthCancel={() => {
          cancelled = true;
        }}
        onMcpClose={() => {
          closed = true;
        }}
      />,
    );

    setup.mockInput.typeText("a");
    await settle(setup);
    setup.mockInput.pressEscape();
    // See the Esc test above: a bare ESC byte waits out the parser's own disambiguation timeout.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle(setup);

    expect(cancelled).toBe(true);
    expect(closed).toBe(false);
  });

  // Four server descriptions with embedded newlines and fences overflow a 14-row viewport and drop the y/n question.
  function noisyCatalog(): McpCatalog {
    return {
      server: "exa",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      tools: Array.from({ length: 4 }, (_unused, index) => ({
        name: `tool_${index}`,
        toolName: `mcp_exa_tool_${index}`,
        description: `Deploys.

import "x";
Deno.serve(() => {
  return 1;
});
END_${index}`,
        inputSchema: {},
      })),
    };
  }

  async function openPreview(catalogue: McpCatalog): Promise<TestRendererSetup> {
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(
      setup,
      <McpPanel rows={rows} onConnect={async () => ({ ok: true, catalog: catalogue })} />,
    );
    setup.mockInput.pressEnter();
    await settle(setup);
    await settle(setup);
    return setup;
  }

  test("the preview names the tool count and the tool names, without their descriptions", async () => {
    const setup = await openPreview(noisyCatalog());

    const frame = setup.captureCharFrame();
    expect(frame).toContain("4 tools");
    expect(frame).toContain("tool_0, tool_1, tool_2, tool_3");
    expect(frame).not.toContain("Deno.serve");
    expect(frame).toContain("[y]es");
  });

  test("d reveals descriptions with newlines collapsed, keeping the question on screen", async () => {
    const setup = await openPreview(noisyCatalog());
    setup.mockInput.typeText("d");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Deno.serve");
    expect(frame).toContain("END_3");
    expect(frame).toContain("[y]es");
  });

  test("keys meant for the list do not reach it while the preview owns the screen", async () => {
    let removed: string | undefined;
    let authed = false;
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(
      setup,
      <McpPanel
        rows={rows}
        onConnect={async (name) => ({ ok: true, catalog: catalog(name) })}
        onRemove={(name) => {
          removed = name;
        }}
        onAuth={async () => {
          authed = true;
          return { status: "success" };
        }}
      />,
    );

    setup.mockInput.pressEnter();
    await settle(setup);
    await settle(setup);
    setup.mockInput.typeText("r");
    await settle(setup);

    expect(removed).toBeUndefined();
    expect(authed).toBe(false);
  });

  // The bug under test is about a real line break, so the fixture has to contain one.
  const NEWLINE = String.fromCharCode(10);

  test("a newline in a tool name cannot break the default row apart", async () => {
    const hostile: McpCatalog = {
      server: "exa",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      tools: [
        {
          name: "safe_tool",
          toolName: "mcp_exa_safe_tool",
          description: "Fine.",
          inputSchema: {},
        },
        {
          name: ["evil", "HIDDEN_TAIL"].join(NEWLINE.repeat(21)),
          toolName: "mcp_exa_evil",
          description: "Fine.",
          inputSchema: {},
        },
      ],
    };
    const setup = await openPreview(hostile);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("HIDDEN_TAIL");
    expect(frame).toContain("[y]es");
  });

  test("the preview's n cancels without trusting", async () => {
    let trusted: McpCatalog | undefined;
    const setup = await createTestRenderer({ width: 100, height: 14 });
    await mount(
      setup,
      <McpPanel
        rows={rows}
        onConnect={async (name) => ({ ok: true, catalog: catalog(name) })}
        onTrust={(c) => {
          trusted = c;
        }}
      />,
    );

    setup.mockInput.pressEnter();
    await settle(setup);
    await settle(setup);
    setup.mockInput.typeText("n");
    await settle(setup);

    expect(trusted).toBeUndefined();
    expect(setup.captureCharFrame()).toContain("MCP servers");
  });
});
