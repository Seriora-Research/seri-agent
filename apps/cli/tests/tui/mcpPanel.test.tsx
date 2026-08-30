/** @jsxImportSource @opentui/react */
// McpPanel.tsx (apps/cli/src/tui/routes/mcp/McpPanel.tsx). Mirrors modelPicker.test.tsx's own
// harness (settle/mount) — the closest full list-panel component test in this codebase (SkillsPanel
// itself has none; App.test.tsx only ever exercises pendingSkills through dispatched actions). No
// test here ever contacts a network: `onConnect` is always a fake supplied by the test, standing in
// for cli.ts's own fetchCatalog-backed handler.

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

// One project group, two servers — enough to prove a header sits between two selectable rows
// without ever becoming one itself.
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

  // The negative control for this test (feeding the FULL header+server array into useListWindow
  // instead of the server-only one) is recorded in this file's own git history / the PR that added
  // it — reverting McpPanel.tsx's `serverRows` filter and re-running this test turns it red.
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

    // Selection starts on the first SERVER row (exa). There are only two selectable rows, so TWO
    // Down presses must still land on the second (vercel) and clamp there — if the header were
    // counted as a third selectable stop, the second press would walk selection past the end of
    // the two real servers and the lookup that turns "selected" back into a row would come up
    // empty, silently dropping the keypress instead of removing vercel.
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
    // A bare ESC byte is ambiguous with the start of every other escape sequence — the parser
    // waits out its own 20ms disambiguation timeout (modelPicker.test.tsx's own comment) before
    // emitting it as a standalone "escape" keypress.
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

    // Static text, not a spinner — this codebase has none (SetupPanel's own "Validating…", this
    // panel's own comment on why).
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

  // The negative control for this test (having 'n' call onTrust the same way 'y' does) is recorded
  // in this file's own git history / the PR that added it — swapping the branch in McpPanel.tsx's
  // McpTrustPreview and re-running this test turns it red.
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

  // Without this the user would authenticate and then have to press Enter on the same row to see
  // anything, with no sign that the login worked.
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

  // A real server writes descriptions with embedded newlines and fenced code blocks (Supabase's
  // deploy_edge_function ships a whole Deno snippet). Four of those rendered in full is more rows
  // than the viewport has, and the y/n question is what falls off the bottom.
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

  // The negative control: drop `singleLine` from McpTrustPreview's description row and re-run.
  // Verified live — each description then renders across six rows, the fourth tool falls outside
  // the 14-row viewport entirely, and the END_3 assertion below goes red.
  test("d reveals descriptions with newlines collapsed, keeping the question on screen", async () => {
    const setup = await openPreview(noisyCatalog());
    setup.mockInput.typeText("d");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Deno.serve");
    expect(frame).toContain("END_3");
    expect(frame).toContain("[y]es");
  });

  // The negative control: drop the `preview` guard from McpPanel's useKeyboard and re-run. Verified
  // live — `removed` becomes "exa", because the list's own handler stays registered behind the
  // preview and fires on the same keypress that cancels it.
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
