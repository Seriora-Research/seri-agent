/** @jsxImportSource @opentui/react */
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
  liveInputEstimate: 0,
  carriedOutputEstimate: 0,
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

// OpenTUI waitFor stops when the scheduler reports idle, which can be before the passive effect publishes the host setter; do not use Date.now() as a deadline here, the key tests mock it.
async function waitUntil(
  setup: TestRendererSetup,
  pred: () => boolean,
  label: string,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await settle(setup);
  }
  if (pred()) return;
  throw new Error(label);
}

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  createRoot(setup.renderer).render(node);
  await settle(setup);
  await settle(setup);
}

describe("TurnStatus", () => {
  test("ticks to a live elapsed time once mounted", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);

    await mount(setup, <TurnStatus startedAt={Date.now()} tokenProgress={ZERO_TOKEN_PROGRESS} />);
    await sleep(1100);
    await settle(setup);

    // Any positive elapsed, not exactly "1s": a CI scheduler delaying the interval by more than a second is harmless.
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
          liveInputEstimate: 0,
          carriedOutputEstimate: 0,
          liveOutputEstimate: 0,
          exact: false,
          hasGap: false,
        }}
      />,
    );

    expect(setup.captureCharFrame()).toContain("~0 ↑, ~5 ↓");
    expect(setup.captureCharFrame()).not.toContain("thinking");
  });

  test("prefixes thinking and keeps elapsed plus tokens on one row", async () => {
    const setup = await createTestRenderer({ width: 60, height: 5 });
    mountedRenderers.push(setup);

    await mount(
      setup,
      <TurnStatus
        startedAt={Date.now()}
        tokenProgress={{
          reconciledInputTokens: 0,
          reconciledOutputTokens: 0,
          liveInputEstimate: 2100,
          carriedOutputEstimate: 0,
          liveOutputEstimate: 180,
          exact: false,
          hasGap: false,
        }}
        thinking
      />,
    );

    const frame = setup.captureCharFrame();
    expect(frame).toContain("thinking");
    expect(frame).toContain("▸");
    expect(frame).toMatch(/\d+s/);
    expect(frame).toContain("↑");
    expect(frame).toContain("↓");
    const lines = frame.split("\n");
    expect(lines[0]).toContain("thinking");
    for (const line of lines.slice(1)) expect(line.trim()).toBe("");
  });

  test("drops the thinking word while a tool is in flight", async () => {
    const setup = await createTestRenderer({ width: 60, height: 5 });
    mountedRenderers.push(setup);

    await mount(
      setup,
      <TurnStatus
        startedAt={Date.now()}
        tokenProgress={ZERO_TOKEN_PROGRESS}
        thinking
        toolInFlight
      />,
    );

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("thinking");
    expect(frame).not.toContain("▸");
    expect(frame).toMatch(/\d+s/);
  });

  test("truncates to one row instead of soft-wrapping onto a second row on a narrow terminal", async () => {
    const setup = await createTestRenderer({ width: 10, height: 5 });
    mountedRenderers.push(setup);

    await mount(
      setup,
      <TurnStatus
        startedAt={Date.now() - 3_600_000}
        tokenProgress={{
          reconciledInputTokens: 1234567,
          reconciledOutputTokens: 1234567,
          liveInputEstimate: 0,
          carriedOutputEstimate: 0,
          liveOutputEstimate: 0,
          exact: true,
          hasGap: false,
        }}
      />,
    );

    const lines = setup.captureCharFrame().split("\n");
    expect(lines[0]).toContain("1h");
    for (const line of lines.slice(1)) expect(line.trim()).toBe("");
  });

  test("renders the live input estimate on the very first frame, with no tick and no reconciliation", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);

    await mount(
      setup,
      <TurnStatus
        startedAt={Date.now()}
        tokenProgress={{
          reconciledInputTokens: 0,
          reconciledOutputTokens: 0,
          liveInputEstimate: 12,
          carriedOutputEstimate: 0,
          liveOutputEstimate: 0,
          exact: false,
          hasGap: false,
        }}
      />,
    );

    expect(setup.captureCharFrame()).toContain("~12 ↑, ~0 ↓");
  });

  test("live output estimate updates from the pending store without a parent tokenProgress prop change, within ~200ms", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    let pending = 0;
    const listeners = new Set<() => void>();

    await mount(
      setup,
      <TurnStatus
        startedAt={Date.now()}
        tokenProgress={ZERO_TOKEN_PROGRESS}
        pendingLiveOutputEstimate={() => pending}
        subscribePendingLive={(listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }}
      />,
    );

    expect(setup.captureCharFrame()).toContain("~0 ↑, ~0 ↓");

    await sleep(160);
    pending = 100;
    for (const listener of listeners) listener();
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("~100 ↓");
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
    // @opentui/react unmount flushSyncWork still runs a plain useEffect cleanup on its own tick, not inside that flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});

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

describe("TurnStatus: the key app.tsx supplies decides whether a new turn re-mounts it", () => {
  test("a changed key (app.tsx's real behavior) forces a fresh mount for the new turn's own now", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    const root = createRoot(setup.renderer);
    const nowSpy = spyOn(globalThis.Date, "now");
    let setStartedAt: ((startedAt: number) => void) | undefined;

    try {
      nowSpy.mockReturnValue(100_000);
      root.render(<TurnStatusHost withKey onReady={(fn) => (setStartedAt = fn)} />);
      await waitUntil(
        setup,
        () => setStartedAt !== undefined,
        "TurnStatusHost never called onReady",
      );
      setStartedAt?.(100_000);
      await waitUntil(
        setup,
        () => setup.captureCharFrame().includes("0s"),
        "first turn never rendered 0s",
      );

      nowSpy.mockReturnValue(500);
      setStartedAt?.(500);
      await waitUntil(
        setup,
        () => setup.captureCharFrame().includes("0s"),
        "remounted turn never rendered 0s",
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("without a key change, the same transition reuses the stale now instead", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    mountedRenderers.push(setup);
    const root = createRoot(setup.renderer);
    const nowSpy = spyOn(globalThis.Date, "now");
    let setStartedAt: ((startedAt: number) => void) | undefined;

    try {
      nowSpy.mockReturnValue(100_000);
      root.render(<TurnStatusHost withKey={false} onReady={(fn) => (setStartedAt = fn)} />);
      await waitUntil(
        setup,
        () => setStartedAt !== undefined,
        "TurnStatusHost never called onReady",
      );
      setStartedAt?.(100_000);
      await waitUntil(
        setup,
        () => setup.captureCharFrame().includes("0s"),
        "first turn never rendered 0s",
      );

      nowSpy.mockReturnValue(500);
      setStartedAt?.(500);
      // The reused now is 100_000 against startedAt 500, which is 99_500ms ("1m 39s"), not "0s".
      await waitUntil(
        setup,
        () => setup.captureCharFrame().includes("1m 39s"),
        "stale now never rendered 1m 39s",
      );
    } finally {
      nowSpy.mockRestore();
    }
  });
});
