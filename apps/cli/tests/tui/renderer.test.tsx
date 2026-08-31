/** @jsxImportSource @opentui/react */
// runtime/renderer.ts's own `unmountBeforeRender` — the fix for `@opentui/react`'s own
// `createRoot(renderer).render(node)` creating a brand new reconciler container on every call
// rather than reconciling into (or tearing down) the previous one, which otherwise leaves whatever
// `useKeyboard`/`usePaste` handlers the previous tree registered permanently attached alongside the
// next tree's own (see runtime/renderer.ts's own comment for the full mechanism and the Ctrl-C bug
// this originally surfaced as), and `runtime/renderOptions.ts`'s own `applyTuiBackground` — the
// other thing `getTuiRenderer` does to a freshly created renderer before anything is mounted into
// it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliRenderer, RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot, useKeyboard } from "@opentui/react";
import { setConfigValue } from "../../src/config/config";
import { applyTuiBackground } from "../../src/tui/runtime/renderOptions";
import { unmountBeforeRender } from "../../src/tui/runtime/renderer";

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

// Two settled passes, not one — the same finding App.test.tsx's own `flush` comment records: a
// fresh mount's own `useKeyboard` doesn't actually subscribe until a second settled pass.
async function flush(setup: TestRendererSetup): Promise<void> {
  await settle(setup);
  await settle(setup);
}

function PageUpCounter({ onPageUp }: { onPageUp: () => void }) {
  useKeyboard((key) => {
    if (key.name === "pageup") onPageUp();
  });
  return null;
}

describe("unmountBeforeRender", () => {
  test("a phase transition's next render() call stops the previous tree's own useKeyboard handler from firing", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    mountedRenderers.push(setup);
    const root = unmountBeforeRender(createRoot(setup.renderer));

    let fireCount = 0;
    root.render(<PageUpCounter onPageUp={() => fireCount++} />);
    await flush(setup);

    // Simulates the next phase transition (welcomeSplash.ts -> cli.ts's runTui, in the real app):
    // the same root renders a fresh instance of the same component, exactly like every one of the
    // three real `root.render(createElement(App, ...))` call sites does.
    root.render(<PageUpCounter onPageUp={() => fireCount++} />);
    await flush(setup);

    setup.mockInput.pressKey("\x1b[5~"); // PageUp
    expect(fireCount).toBe(1);
  });

  // The negative control this file's own claim needs: without `unmountBeforeRender`, the same
  // scenario really does double-fire — proving the assertion above is not vacuous.
  test("without unmountBeforeRender, the same scenario double-fires (negative control)", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    mountedRenderers.push(setup);
    const root = createRoot(setup.renderer);

    let fireCount = 0;
    root.render(<PageUpCounter onPageUp={() => fireCount++} />);
    await flush(setup);

    root.render(<PageUpCounter onPageUp={() => fireCount++} />);
    await flush(setup);

    setup.mockInput.pressKey("\x1b[5~"); // PageUp
    expect(fireCount).toBe(2);
  });
});

describe("applyTuiBackground", () => {
  let configDir: string;
  // Env hygiene: `configValue` reads process.env before config.json, so a dev box or CI runner
  // with SERI_TUI_BACKGROUND genuinely exported would otherwise decide both assertions below.
  const originalBackground = process.env.SERI_TUI_BACKGROUND;

  beforeEach(() => {
    delete process.env.SERI_TUI_BACKGROUND;
    configDir = mkdtempSync(join(tmpdir(), "seri-tui-background-test-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    // Teardown must `delete`, never reassign `undefined` — Bun/Node coerce
    // `process.env.X = undefined` to the literal string "undefined" (code-quality.md's own
    // cross-platform env-var lesson).
    if (originalBackground === undefined) delete process.env.SERI_TUI_BACKGROUND;
    else process.env.SERI_TUI_BACKGROUND = originalBackground;
  });

  async function freshRenderer(): Promise<CliRenderer> {
    const setup = await createTestRenderer({ width: 20, height: 4 });
    mountedRenderers.push(setup);
    return setup.renderer;
  }

  // Reads past `backgroundColor`'s `private` declaration on purpose: the claim is that the
  // renderer's OWN ground moved, and a spy on `setBackgroundColor` would pass just as happily
  // against `CliRendererConfig.backgroundColor`, which @opentui/core 0.5.6 accepts and then never
  // reads (see runtime/renderOptions.ts).
  function ground(renderer: CliRenderer): [number, number, number, number] {
    return (renderer as unknown as { backgroundColor: RGBA }).backgroundColor.toInts();
  }

  test("paints the ground named by SERI_TUI_BACKGROUND", async () => {
    setConfigValue("SERI_TUI_BACKGROUND", "#141413", configDir);
    const renderer = await freshRenderer();

    applyTuiBackground(renderer, configDir);

    expect(ground(renderer)).toEqual(RGBA.fromHex("#141413").toInts());
  });

  test("leaves the terminal's own ground alone when nothing is configured", async () => {
    const renderer = await freshRenderer();

    applyTuiBackground(renderer, configDir);

    // Fully transparent — the renderer's own untouched default, which is what lets a terminal's
    // transparency and blur survive.
    expect(ground(renderer)).toEqual([0, 0, 0, 0]);
  });
});
