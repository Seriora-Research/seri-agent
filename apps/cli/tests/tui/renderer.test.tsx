/** @jsxImportSource @opentui/react */
// runtime/renderer.ts's own `unmountBeforeRender` — the fix for `@opentui/react`'s own
// `createRoot(renderer).render(node)` creating a brand new reconciler container on every call
// rather than reconciling into (or tearing down) the previous one, which otherwise leaves whatever
// `useKeyboard`/`usePaste` handlers the previous tree registered permanently attached alongside the
// next tree's own (see runtime/renderer.ts's own comment for the full mechanism and the Ctrl-C bug
// this originally surfaced as).

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot, useKeyboard } from "@opentui/react";
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
