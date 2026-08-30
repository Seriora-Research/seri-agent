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
    expect(frame).toContain("Search the web.");
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
