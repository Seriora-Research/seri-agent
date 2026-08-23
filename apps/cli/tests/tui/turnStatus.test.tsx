/** @jsxImportSource @opentui/react */
// TurnStatus.tsx — real-timer test, matching inputThrottle.test.tsx's own harness (no fake-timer
// library anywhere in this repo): `createTestRenderer`/`createRoot`, real `setTimeout`-based
// sleep/settle, and `spyOn(globalThis, ...)` to assert scheduling without controlling time.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { TurnStatus } from "../../src/tui/components/TurnStatus";
import type { TokenProgress } from "../../src/tui/util/format";

const ZERO_TOKEN_PROGRESS: TokenProgress = {
  reconciledInputTokens: 0,
  reconciledOutputTokens: 0,
  liveOutputEstimate: 0,
  exact: false,
  hasGap: false,
};

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
  test("ticks to a live elapsed time once mounted", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);

    await mount(setup, <TurnStatus startedAt={Date.now()} tokenProgress={ZERO_TOKEN_PROGRESS} />);
    await sleep(1100);
    await settle(setup); // flushes the 1Hz tick's own setState into a render

    // Any positive elapsed-seconds value, not exactly "1s": a CI scheduler delaying the interval
    // callback or render by more than a second is a real, harmless possibility this assertion must
    // tolerate — the only thing under test is that elapsed time advances past "0s" at all.
    expect(setup.captureCharFrame()).toMatch(/\b[1-9]\d*s\b/);
  });

  test("renders a token count alongside the elapsed time when tokenProgress is present", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);

    await mount(
      setup,
      <TurnStatus
        startedAt={Date.now()}
        tokenProgress={{
          reconciledInputTokens: 0,
          reconciledOutputTokens: 5,
          liveOutputEstimate: 0,
          exact: false,
          hasGap: false,
        }}
      />,
    );

    expect(setup.captureCharFrame()).toContain("~0 in, ~5 out");
  });

  test("clears its own interval on unmount, leaving nothing running", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    const root = createRoot(setup.renderer);

    root.render(<TurnStatus startedAt={Date.now()} tokenProgress={ZERO_TOKEN_PROGRESS} />);
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

// A stand-in for app.tsx's own `state.turn !== undefined && <TurnStatus key={...} .../>`
// conditional-mount site, driven by a real `useState` inside a PERSISTENT tree (not a fresh
// `root.render()` call per turn, which would exercise a different, top-level reconciliation path
// than the nested one app.tsx's own long-lived component tree actually goes through). `withKey`
// toggles between app.tsx's real `key={startedAt}` and a fixed key, so the same harness proves both
// the fix and its own negative control.
function TurnStatusHost({
  withKey,
  onReady,
}: {
  withKey: boolean;
  onReady: (setStartedAt: (startedAt: number) => void) => void;
}) {
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  useEffect(() => onReady(setStartedAt), [onReady]);
  return startedAt === undefined ? null : (
    <TurnStatus
      key={withKey ? startedAt : "fixed"}
      startedAt={startedAt}
      tokenProgress={ZERO_TOKEN_PROGRESS}
    />
  );
}

// app.tsx's own `key={state.turn.startedAt}` on the conditionally-mounted TurnStatus: without a
// changed key, a prop-only update reuses the existing fiber, and this component's own
// `useState(() => Date.now())` initializer — which only runs on a genuine mount — does not re-run.
// `Date.now()` is mocked here (not real elapsed time) so both scenarios below are deterministic:
// each turn's `startedAt` is set to MATCH whatever `Date.now()` is mocked to return at that moment,
// so a fresh mount's own `now` always lands on `startedAt` (elapsed "0s"), while a stale,
// carried-over `now` from the FIRST mount lands far away from the second turn's `startedAt` (a
// large, wrong elapsed) — the two are unambiguous in the rendered frame regardless of how much real
// wall-clock time this test itself takes to run.
describe("TurnStatus: the key app.tsx supplies decides whether a new turn re-mounts it", () => {
  test("a changed key (app.tsx's real behavior) forces a fresh mount for the new turn's own now", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    const root = createRoot(setup.renderer);
    const nowSpy = spyOn(Date, "now");
    let setStartedAt: ((startedAt: number) => void) | undefined;

    nowSpy.mockReturnValue(100_000);
    root.render(<TurnStatusHost withKey onReady={(fn) => (setStartedAt = fn)} />);
    await settle(setup);
    setStartedAt?.(100_000);
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("0s");

    // The next turn, with a genuinely different startedAt.
    nowSpy.mockReturnValue(500);
    setStartedAt?.(500);
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("0s");
    nowSpy.mockRestore();
  });

  // The negative control: the identical transition, but with a key that does NOT change — proving
  // the fresh-mount guarantee above genuinely depends on the key, not on something else.
  test("without a key change, the same transition reuses the stale now instead", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    const root = createRoot(setup.renderer);
    const nowSpy = spyOn(Date, "now");
    let setStartedAt: ((startedAt: number) => void) | undefined;

    nowSpy.mockReturnValue(100_000);
    root.render(<TurnStatusHost withKey={false} onReady={(fn) => (setStartedAt = fn)} />);
    await settle(setup);
    setStartedAt?.(100_000);
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("0s");

    nowSpy.mockReturnValue(500);
    setStartedAt?.(500);
    await settle(setup);

    // The reused instance's `now` is still 100_000 (the first mount's value, never re-initialized)
    // against the new `startedAt` of 500 — a 99_500ms elapsed ("1m 39s"), not "0s".
    expect(setup.captureCharFrame()).toContain("1m 39s");
    nowSpy.mockRestore();
  });
});
