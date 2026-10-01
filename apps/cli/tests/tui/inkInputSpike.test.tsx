/** @jsxImportSource @opentui/react */
// @opentui/react is pre-1.0: useKeyboard subscribes from a passive useEffect after the second macrotask commit, which is the mount() contract every keyboard test in this suite relies on.
import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot, useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";
import { useState } from "react";

const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

function Probe() {
  const [lastKey, setLastKey] = useState("none");
  useKeyboard((key) => setLastKey(key.sequence));
  return <text>last: {lastKey}</text>;
}

async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  createRoot(setup.renderer).render(node);
  await settle(setup);
  await settle(setup);
}

describe("@opentui/react mock-input / useKeyboard wiring spike", () => {
  test("a keypress registers once the standard two-settle mount() pattern has let useKeyboard's effect subscribe", async () => {
    const setup = await createTestRenderer({ width: 30, height: 3 });
    mountedRenderers.push(setup);
    await mount(setup, <Probe />);

    setup.mockInput.pressKey("a");
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("last: a");
  });
});
