/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";

import { InputBox } from "../../src/tui/components/InputBox";

const THROTTLE_MS = 50;

// createTestRenderer registers on the process-wide TerminalConsoleCache singleton; an undestroyed CliRenderer flakes later files in the same bun process.
const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// @opentui/react commits on a macrotask; useKeyboard/usePaste subscribe on the second settled pass.
async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  createRoot(setup.renderer).render(node);
  await settle(setup);
  await settle(setup);
  // Under CPU contention on CI, this file's afterEach destroy left the next test's keyboard subscription unregistered after two passes.
  await settle(setup);
}

describe("InputBox throttled repaints", () => {
  // mockInput.pressKey emits stdin synchronously, so a setTimeout spy around one keypress isolates that stroke.
  test("keystrokes spaced beyond the throttle window each flush immediately, without ever scheduling a pending timer", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    await mount(setup, <InputBox onSubmit={() => {}} />);

    const gapMs = THROTTLE_MS + 50; // slower than THROTTLE_MS: a deliberate typing pace, never coalesced
    const chars = "abcde";
    for (const ch of chars) {
      const setTimeoutSpy = spyOn(globalThis, "setTimeout");
      setup.mockInput.pressKey(ch);
      const scheduled = setTimeoutSpy.mock.calls.length;
      setTimeoutSpy.mockRestore();

      expect(scheduled).toBe(0);
      await settle(setup);
      await sleep(gapMs);
    }

    expect(setup.captureCharFrame()).toContain(`> ${chars}`);
  });

  test("a keystroke right after submit gets its own immediate flush, not a throttle delay left over from before Enter", async () => {
    const submitted: string[] = [];
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    await mount(setup, <InputBox onSubmit={(v) => submitted.push(v)} />);

    // All four land in one synchronous burst: no real time between the leading-edge "h" flush and the "y" after Enter.
    setup.mockInput.pressKey("h");
    setup.mockInput.pressKey("i");
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey("y");
    await settle(setup);

    expect(submitted).toEqual(["hi"]);
    expect(setup.captureCharFrame()).toContain("> y");
  });
});
