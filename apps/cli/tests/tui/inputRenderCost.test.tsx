/** @jsxImportSource @opentui/react */
// createTestRenderer defaults to bufferedOutput "memory"; bufferedOutput "stdout" plus a real stdout is the NativeSpanFeed path runTui uses.

import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../../src/tui/app";
import { MAIN_TUI_RENDERER_CONFIG } from "../../src/tui/runtime/renderOptions";
import { theme } from "../../src/tui/theme/theme";
import type { TuiAction } from "../../src/tui/state/reducer";
import type { TranscriptRole } from "../../src/tui/util/format";
import { flush, route, session } from "./helpers";

// Named so the marginal-bytes threshold derives from the same width FakeTty reports.
const TEST_COLUMNS = 100;

class FakeTty extends Writable {
  isTTY = true as const;
  columns = TEST_COLUMNS;
  rows: number;
  bytes = 0;
  writes = 0;
  raw = "";

  constructor(rows: number) {
    super();
    this.rows = rows;
  }

  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void) {
    const text = String(chunk);
    this.bytes += text.length;
    this.writes += 1;
    this.raw += text;
    callback();
  }

  // The native renderer probes this before writing truecolor SGRs.
  getColorDepth(): number {
    return 24;
  }
}

const MESSAGE = "> how do I refactor this function";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function measureBackspaceCost(options: {
  rows: number;
  role: TranscriptRole;
  seedCount: number;
  inputLength: number;
  n: number;
}): Promise<{ bytes: number; writes: number; raw: string; setupRaw: string }> {
  const { rows, role, seedCount, inputLength, n } = options;
  const stdout = new FakeTty(rows);
  let dispatch: ((action: TuiAction) => void) | undefined;

  const setup: TestRendererSetup = await createTestRenderer({
    ...MAIN_TUI_RENDERER_CONFIG,
    width: TEST_COLUMNS,
    height: rows,
    stdout: stdout as unknown as NodeJS.WriteStream,
    bufferedOutput: "stdout",
  });
  createRoot(setup.renderer).render(
    <App
      session={session()}
      route={route()}
      catalog={undefined}
      config={{}}
      onSubmit={() => {}}
      connectDispatch={(d) => {
        dispatch = d;
      }}
    />,
  );
  await flush(setup);
  if (dispatch === undefined) throw new Error("connectDispatch never fired");

  for (let i = 0; i < seedCount; i++) {
    dispatch({ type: "transcript-append", line: MESSAGE, role });
  }
  await flush(setup);

  await setup.mockInput.typeText("x".repeat(inputLength));
  await flush(setup);

  const setupRaw = stdout.raw;

  // 60ms, not tighter: InputBox THROTTLE_MS is 50ms and would coalesce n backspaces into far fewer than n frames.
  for (let i = 0; i < 5; i++) {
    setup.mockInput.pressBackspace();
    await sleep(60);
    await flush(setup);
  }

  stdout.bytes = 0;
  stdout.writes = 0;
  stdout.raw = "";

  for (let i = 0; i < n; i++) {
    setup.mockInput.pressBackspace();
    await sleep(60);
    await flush(setup);
  }

  setup.renderer.destroy();
  return { bytes: stdout.bytes, writes: stdout.writes, raw: stdout.raw, setupRaw };
}

describe("TUI input render cost", () => {
  const n = theme.userBg.startsWith("#") ? theme.userBg.slice(1) : theme.userBg;
  const USER_BG_SGR = `\x1b[48;2;${Number.parseInt(n.slice(0, 2), 16)};${Number.parseInt(n.slice(2, 4), 16)};${Number.parseInt(n.slice(4, 6), 16)}m`;

  // OpenTUI cell-diffs only the input row, so a wide user-band cannot inflate per-keystroke bytes the way Ink log-update did.
  test("editing the input box costs the same bytes regardless of the transcript's role mix", async () => {
    const n = 20;
    const seedCount = 6;
    const rows = 40;

    const userRun = await measureBackspaceCost({
      rows,
      role: "user",
      seedCount,
      inputLength: 300,
      n,
    });
    const systemRun = await measureBackspaceCost({
      rows,
      role: "system",
      seedCount,
      inputLength: 300,
      n,
    });

    expect(userRun.setupRaw).toContain(USER_BG_SGR);
    expect(systemRun.setupRaw).not.toContain(USER_BG_SGR);

    expect(2 * seedCount - 1).toBeLessThanOrEqual(rows);

    expect(userRun.writes).toBeGreaterThanOrEqual(n);
    expect(systemRun.writes).toBeGreaterThanOrEqual(n);

    expect(userRun.bytes).toBe(systemRun.bytes);
    expect(userRun.raw).toBe(systemRun.raw);
  });
});
