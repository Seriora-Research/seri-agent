/** @jsxImportSource @opentui/react */
// TurnStatus.tsx — real-timer test, matching inputThrottle.test.tsx's own harness (no fake-timer
// library anywhere in this repo): `createTestRenderer`/`createRoot`, real `setTimeout`-based
// sleep/settle, and `spyOn(globalThis, ...)` to assert scheduling without controlling time.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import type { ReactNode } from "react";
import { useState } from "react";
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

// A minimal stateful host so a `turnStartedAt` PROP transition on an already-mounted TurnStatus
// can actually be exercised: calling `createRoot(renderer).render(...)` a SECOND time builds a
// brand-new reconciler container rather than updating props on the existing tree (this file's own
// `unmount`-not-re-render comment below), so it can never re-use the same TurnStatus instance. This
// wrapper's own instance persists across the `controller.set` calls below, so TurnStatus genuinely
// receives a new `turnStartedAt` prop on its existing instance instead.
function TurnStatusHost({
  initial,
  controller,
}: {
  initial: number | undefined;
  controller: { set?: (value: number | undefined) => void };
}) {
  const [turnStartedAt, setTurnStartedAt] = useState(initial);
  controller.set = setTurnStartedAt;
  return <TurnStatus turnStartedAt={turnStartedAt} tokenProgress={undefined} />;
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
        tokenProgress={{
          reconciledInputTokens: 0,
          reconciledOutputTokens: 5,
          liveOutputEstimate: 0,
          inputExact: false,
          outputExact: false,
        }}
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

  // Regression guard for the negative-elapsed-time fix (TurnStatus.tsx's own `Math.max(0, ...)`
  // clamp): TurnStatus stays mounted across turns, so a `turnStartedAt` prop transition (turn 2
  // starting right after turn 1 ends) is a real, common case. `settle()` alone is not enough to
  // observe the bug this guards against: by the time its `await`s resolve, the passive effect's
  // own corrective `setNow(Date.now())` has already flushed, so the transient negative frame is
  // gone before the test ever captures it. `flushSync` forces the render reflecting the new
  // `turnStartedAt` to commit immediately, before that effect gets a chance to run, so the frame
  // captured right after it is the one the clamp actually has to fix — reverting the clamp turns
  // this red by rendering `-1s` there.
  test("a turnStartedAt prop transition clears the old interval and starts a fresh, never-negative clock", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    const controller: { set?: (value: number | undefined) => void } = {};

    await mount(setup, <TurnStatusHost initial={Date.now()} controller={controller} />);
    await sleep(1100);
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("1s");

    const clearIntervalSpy = spyOn(globalThis, "clearInterval");
    // Simulates turn 2's own `turn-started` landing right after turn 1 ended.
    flushSync(() => controller.set?.(Date.now()));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toMatch(/-\d/);

    // Confirms the clock also self-corrects to a sane positive value afterward, not just that the
    // immediate frame above was clamped.
    await settle(setup);
    await settle(setup);
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(setup.captureCharFrame()).not.toMatch(/-\d/);
  });

  test("a turnStartedAt prop transition to undefined clears the interval and renders nothing", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    const controller: { set?: (value: number | undefined) => void } = {};

    await mount(setup, <TurnStatusHost initial={Date.now()} controller={controller} />);
    await settle(setup);

    const clearIntervalSpy = spyOn(globalThis, "clearInterval");
    controller.set?.(undefined);
    await settle(setup);
    await settle(setup);

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(setup.captureCharFrame().trim()).toBe("");
  });
});
