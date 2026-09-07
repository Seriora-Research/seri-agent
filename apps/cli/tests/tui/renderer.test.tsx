/** @jsxImportSource @opentui/react */
// @opentui/react createRoot(renderer).render creates a new reconciler each call and leaves the previous useKeyboard/usePaste handlers attached.

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

// A fresh mount's useKeyboard does not subscribe until a second settled pass.
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

    root.render(<PageUpCounter onPageUp={() => fireCount++} />);
    await flush(setup);

    setup.mockInput.pressKey("\x1b[5~"); // PageUp
    expect(fireCount).toBe(1);
  });

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
  // configValue reads process.env before config.json, so a runner with SERI_TUI_BACKGROUND exported would decide both assertions.
  const originalBackground = process.env.SERI_TUI_BACKGROUND;

  beforeEach(() => {
    delete process.env.SERI_TUI_BACKGROUND;
    configDir = mkdtempSync(join(tmpdir(), "seri-tui-background-test-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    // Bun/Node coerce process.env.X = undefined to the string "undefined"; teardown must delete.
    if (originalBackground === undefined) delete process.env.SERI_TUI_BACKGROUND;
    else process.env.SERI_TUI_BACKGROUND = originalBackground;
  });

  async function freshRenderer(): Promise<CliRenderer> {
    const setup = await createTestRenderer({ width: 20, height: 4 });
    mountedRenderers.push(setup);
    return setup.renderer;
  }

  // @opentui/core 0.5.6 accepts CliRendererConfig.backgroundColor and never reads it; the private backgroundColor is the ground that actually moved.
  function ground(renderer: CliRenderer): [number, number, number, number] {
    return (renderer as unknown as { backgroundColor: RGBA }).backgroundColor.toInts();
  }

  test("paints the ground named by SERI_TUI_BACKGROUND", async () => {
    setConfigValue("SERI_TUI_BACKGROUND", "#141413", configDir);
    const renderer = await freshRenderer();

    applyTuiBackground(renderer, configDir);

    expect(ground(renderer)).toEqual(RGBA.fromHex("#141413").toInts());
  });

  test("paints paper when nothing is configured", async () => {
    const renderer = await freshRenderer();

    applyTuiBackground(renderer, configDir);

    expect(ground(renderer)).toEqual(RGBA.fromHex("#141413").toInts());
  });

  test("leaves the terminal's own ground alone when SERI_TUI_BACKGROUND is terminal", async () => {
    setConfigValue("SERI_TUI_BACKGROUND", "terminal", configDir);
    const renderer = await freshRenderer();

    applyTuiBackground(renderer, configDir);

    // Fully transparent is the renderer's untouched default, which is what lets terminal transparency survive.
    expect(ground(renderer)).toEqual([0, 0, 0, 0]);
  });
});
