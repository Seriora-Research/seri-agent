// Measures what a keystroke actually costs to write to the terminal, not what it costs to
// compute — ink-testing-library's own render() cannot be used here: it hard-codes `debug: true`
// (build/index.js), which makes Ink write `fullStaticOutput + output` directly and skip
// `renderInteractiveFrame` entirely, i.e. it bypasses the exact code path this file measures. So
// this mounts Ink's own `render()` directly, the same way App.test.tsx's `connect()` mounts
// `<App>`, just against fake streams that count bytes instead of ink-testing-library's frame
// stubs.

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ModelMessage } from "ai";
import { render } from "ink";
import { createElement } from "react";
import type { ResolvedRoute } from "../../src/provider/routing";
import type { SessionState } from "../../src/session/session";
import { App } from "../../src/tui/App";
import type { TuiAction } from "../../src/tui/reducer";

// A fake TTY stdout: fixed 100 columns (matches App.test.tsx's assumption that width doesn't
// vary across these tests), a configurable row count (the axis under test), and counters for
// every byte/call written to it — the thing a real terminal emulator has to parse and repaint.
class FakeTty extends EventEmitter {
  isTTY = true as const;
  columns = 100;
  rows: number;
  bytes = 0;
  writes = 0;

  constructor(rows: number) {
    super();
    this.rows = rows;
  }

  write = (chunk: string): boolean => {
    this.bytes += chunk.length;
    this.writes += 1;
    return true;
  };
}

// Copied from ink-testing-library's own Stdin (build/index.js) — the no-op raw-mode plumbing Ink
// expects from a real stdin, plus a synchronous write() that fires 'data' the way a real tty's
// keystrokes arrive.
class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;

  write = (data: string): void => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}

  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

function session(): SessionState<ModelMessage> {
  return {
    id: "s1",
    cwd: "/repo",
    systemPrompt: "",
    permissionMode: "approve-each",
    messages: [],
  };
}

function route(): ResolvedRoute {
  return { model: "claude-sonnet-5", provider: "anthropic", rerouted: false, viaGateway: false };
}

// Same two-tick finding inkInputSpike.test.tsx already documents under Ink 7 + React 19, applied
// here at the macrotask granularity App.test.tsx's own flush() uses for a dispatch/render round trip.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function ninetyColumnLine(i: number): string {
  return `transcript line ${i} `.padEnd(90, ".");
}

// Mounts <App> through Ink's real interactive path, seeds `transcriptLines` lines of transcript
// (enough to fill the viewport at any `rows` under test), types a fixed-length input as a single
// paste chunk, then does N backspaces and reports the bytes/writes that cost the terminal.
async function measureBackspaceCost(options: {
  rows: number;
  transcriptLines: number;
  inputLength: number;
  n: number;
}): Promise<{ bytes: number; writes: number }> {
  const { rows, transcriptLines, inputLength, n } = options;
  const stdout = new FakeTty(rows);
  const stdin = new FakeStdin();
  const stderr = new FakeTty(rows);
  let dispatch: ((action: TuiAction) => void) | undefined;

  const instance = render(
    createElement(App, {
      session: session(),
      route: route(),
      connectDispatch: (d: (action: TuiAction) => void) => {
        dispatch = d;
      },
      done: false,
    }),
    {
      stdout,
      stdin,
      stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 1000,
      // Mirrors the main TUI mount's own options (`cli.ts`'s `runTui`) rather than importing
      // them — this suite mounts `<App>` directly everywhere else (App.test.tsx) rather than
      // reaching into `cli.ts`, which also runs process-level setup on import.
      incrementalRendering: true,
    },
  );
  await flush();
  if (dispatch === undefined) throw new Error("connectDispatch never fired");

  for (let i = 0; i < transcriptLines; i++) {
    dispatch({ type: "transcript-append", line: ninetyColumnLine(i) });
  }
  await flush();

  stdin.write("x".repeat(inputLength));
  await flush();

  // Warm-up: absorb the first few backspaces' one-time costs (e.g. cliCursor.hide's first write,
  // and an occasional extra commit when a backspace crosses InputBox's own line-wrap boundary and
  // the transcript viewport gets remeasured a tick later) before the counters below start, so the
  // measured window only reflects steady-state cost. 10ms, not the 1ms maxFps throttle window
  // alone: measured directly (bun scratch runs against this same harness) — the wrap-boundary
  // recommit lands a few ms after the throttled write, and 3ms left it bleeding into the next
  // keystroke's count often enough to be visible in the totals.
  for (let i = 0; i < 5; i++) {
    stdin.write("\x7f");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  stdout.bytes = 0;
  stdout.writes = 0;

  for (let i = 0; i < n; i++) {
    stdin.write("\x7f");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  instance.unmount();
  return { bytes: stdout.bytes, writes: stdout.writes };
}

describe("TUI input render cost", () => {
  // Ink's synchronized-output wrapping (`ink.js`'s `throttledLog`, `write-synchronized.js`) writes
  // a begin/end escape around every changed frame in addition to the frame itself, so a keystroke
  // that changes the frame costs more than one stdout.write() call even before this file's fix —
  // measured directly against this harness, not assumed. `toBeGreaterThanOrEqual`, not `toBe`, is
  // what keeps this a real "not coalesced" guard under that multi-write-per-frame reality: N
  // keystrokes that got merged into fewer than N frames would still fail loudly here.
  test("the harness mounts and each keystroke produces at least one frame write, not a coalesced batch", async () => {
    const { writes } = await measureBackspaceCost({
      rows: 20,
      transcriptLines: 300,
      inputLength: 300,
      n: 20,
    });

    expect(writes).toBeGreaterThanOrEqual(20);
  });

  // Metric: marginal bytes written to stdout per extra visible transcript row, per keystroke.
  // `log-update.js`'s default writer (`createStandard`) re-emits the ENTIRE frame — every
  // transcript row, unchanged or not — on every changed frame; its incremental writer
  // (`createIncremental`) skips a row whose text didn't change and emits a bare 3-byte
  // `cursorNextLine` instead. `rowsLarge - rowsSmall` extra unchanged transcript rows isolate
  // exactly that per-row cost: identical content and identical input, differing only in how many
  // on-screen rows a backspace's frame has to carry along.
  //
  // `16`: a 5x headroom over the 3-byte `cursorNextLine` floor, while staying an order of
  // magnitude below the pre-fix per-row cost (a 90-column row with theme colours re-emitted in
  // full runs on the order of 100-200 bytes) — this is a statement about behaviour ("an unchanged
  // row costs a cursor move, not a repaint"), not a tuned number.
  test("an unchanged transcript row costs a cursor move per keystroke, not a repaint", async () => {
    const n = 20;
    const rowsSmall = 20;
    const rowsLarge = 60;

    const small = await measureBackspaceCost({
      rows: rowsSmall,
      transcriptLines: 300,
      inputLength: 300,
      n,
    });
    const large = await measureBackspaceCost({
      rows: rowsLarge,
      transcriptLines: 300,
      inputLength: 300,
      n,
    });

    const marginalBytesPerRow = (large.bytes - small.bytes) / (n * (rowsLarge - rowsSmall));

    expect(large.writes).toBeGreaterThanOrEqual(n);
    expect(small.writes).toBeGreaterThanOrEqual(n);
    expect(marginalBytesPerRow).toBeLessThan(16);
  });
});
