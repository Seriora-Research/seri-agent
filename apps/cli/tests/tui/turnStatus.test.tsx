/** @jsxImportSource @opentui/react */
// TurnStatus.tsx — real-timer test, matching inputThrottle.test.tsx's own harness (no fake-timer
// library anywhere in this repo): `createTestRenderer`/`createRoot`, real `setTimeout`-based
// sleep/settle, and `spyOn(globalThis, ...)` to assert scheduling without controlling time.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";
import { TurnStatus } from "../../src/tui/components/TurnStatus";

const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  createRoot(setup.renderer).render(node);
  await settle(setup); // commits the mount
  await settle(setup); // lets the passive useEffect above run and schedule its interval
}

describe("TurnStatus", () => {
  test("renders nothing while no turn is in flight", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);

    await mount(setup, <TurnStatus turnStartedAt={undefined} tokenProgress={undefined} />);

    expect(setup.captureCharFrame().trim()).toBe("");
  });

  test("ticks to a live elapsed time once a turn is in flight", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);

    await mount(setup, <TurnStatus turnStartedAt={Date.now()} tokenProgress={undefined} />);
    await sleep(1100);
    await settle(setup); // flushes the 1Hz tick's own setState into a render

    expect(setup.captureCharFrame()).toContain("1s");
  });

  test("renders a token count alongside the elapsed time when tokenProgress is present", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);

    await mount(
      setup,
      <TurnStatus
        turnStartedAt={Date.now()}
        tokenProgress={{ inputTokens: 0, outputTokens: 5, inputExact: false, outputExact: false }}
      />,
    );

    expect(setup.captureCharFrame()).toContain("~0 in, ~5 out");
  });

  // `root.unmount()`, not a second `root.render()` call with `turnStartedAt: undefined` — this
  // codebase's own `unmountBeforeRender` comment (renderer.test.tsx) documents that
  // @opentui/react's `createRoot(renderer).render(node)` creates a brand-new reconciler container
  // on every call rather than updating props on the existing tree, so a second bare `.render()`
  // call here would mount a fresh, unrelated TurnStatus instance instead of exercising THIS one's
  // own cleanup — unmount is the one operation that reliably tears down the mounted instance's own
  // effect.
  test("clears its own interval on unmount, leaving nothing running", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    const root = createRoot(setup.renderer);

    root.render(<TurnStatus turnStartedAt={Date.now()} tokenProgress={undefined} />);
    await settle(setup);
    await settle(setup);

    const clearIntervalSpy = spyOn(globalThis, "clearInterval");
    root.unmount();
    // `unmount` (createRoot's own `cleanup`, @opentui/react) commits the teardown via
    // `flushSyncWork`, but a plain `useEffect` cleanup (as opposed to `useLayoutEffect`) still runs
    // as a passive effect on its own tick, not synchronously inside that flush — a real event-loop
    // tick is what lets React actually run it before this test reads the spy.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
