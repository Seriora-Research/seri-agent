// Measures what a keystroke actually costs to write to the terminal, not what it costs to
// compute — ink-testing-library's own render() cannot be used here: it hard-codes `debug: true`
// (build/index.js), which makes Ink write `fullStaticOutput + output` directly and skip
// `renderInteractiveFrame` entirely, i.e. it bypasses the exact code path this file measures. So
// this mounts Ink's own `render()` directly, the same way App.test.tsx's `connect()` mounts
// `<App>`, just against fake streams that count bytes instead of ink-testing-library's frame
// stubs.

import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { ModelMessage } from "ai";
import { render } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import type { ResolvedRoute } from "../../src/provider/routing";
import type { SessionState } from "../../src/session/session";
import { App } from "../../src/tui/App";
import type { TranscriptRole } from "../../src/tui/format";
import type { TuiAction } from "../../src/tui/reducer";
import { MAIN_TUI_RENDER_OPTIONS } from "../../src/tui/renderOptions";

// `chalk` (used by `ink/build/colorize.js`) is not a direct dependency of this package, and its
// color level is normally auto-detected once, at import time, from the real process's stdout —
// which stays non-TTY (level 0, `colorize` a no-op) under `bun test`, and since module loads are
// cached process-wide across every test file in a `bun test` run, whichever file happens to
// import `ink` first "locks in" that level for every other file too. Resolving `chalk` through
// `ink`'s own `require` (ink declares it as ITS dependency, so this is allowed even though this
// package doesn't) rather than importing it directly here sidesteps both problems: it reaches the
// exact singleton instance `colorize.js` already uses, and mutating `.level` works no matter when
// or at what level it was first loaded, because `level` is read live on every colorize call, not
// cached (chalk's own `applyStyle`).
const chalk = (await import(createRequire(import.meta.resolve("ink")).resolve("chalk"))).default;
// Restored in afterAll below: this is the same process-wide singleton every other test file's
// `ink` import shares, so leaving `.level` mutated here would leak color support into whichever
// file runs after this one in the same `bun test` process.
const originalChalkLevel = chalk.level;
chalk.level = 3;

afterAll(() => {
  chalk.level = originalChalkLevel;
});

// A fake TTY stdout: fixed 100 columns (matches App.test.tsx's assumption that width doesn't
// vary across these tests), a configurable row count (the axis under test), and counters for
// every byte/call written to it — the thing a real terminal emulator has to parse and repaint.
// `raw` accumulates the actual written text (not just its length) so a test can assert on the
// bytes' own content, not only their count.
class FakeTty extends EventEmitter {
  isTTY = true as const;
  columns = 100;
  rows: number;
  bytes = 0;
  writes = 0;
  raw = "";

  constructor(rows: number) {
    super();
    this.rows = rows;
  }

  write = (chunk: string): boolean => {
    this.bytes += chunk.length;
    this.writes += 1;
    this.raw += chunk;
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

// A realistic short user turn — 33 display cells, the same representative row the root-cause
// measurement in the bugfix report used.
const MESSAGE = "> how do I refactor this function";

// Mounts <App> through Ink's real interactive path, seeds `seedCount` transcript rows of a fixed
// `role` (all the same `MESSAGE` text, so only the role differs between two runs), types a
// fixed-length input as a single paste chunk, then does N backspaces and reports the bytes/writes
// that cost the terminal.
async function measureBackspaceCost(options: {
  rows: number;
  role: TranscriptRole;
  seedCount: number;
  inputLength: number;
  n: number;
}): Promise<{ bytes: number; writes: number; raw: string }> {
  const { rows, role, seedCount, inputLength, n } = options;
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
      // Ink's own RenderOptions types stdout/stdin/stderr as real Node streams; these fakes only
      // implement the subset Ink actually calls (same minimal shape ink-testing-library's own
      // Stdout/Stdin fakes use against the same option).
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      patchConsole: false,
      // No `maxFps` override: this measures the real mount's own frame-write cost, and (per the
      // bugfix report's root-cause reading) InputBox's own 50ms local throttle is already coarser
      // than Ink's ~33ms default, so it dominates the render cadence here regardless.
      // The main TUI mount's own options (`cli.ts`'s `runTui`), imported rather than copied so a
      // revert of `incrementalRendering` there fails this suite instead of leaving it green.
      ...MAIN_TUI_RENDER_OPTIONS,
    },
  );
  await flush();
  if (dispatch === undefined) throw new Error("connectDispatch never fired");

  for (let i = 0; i < seedCount; i++) {
    dispatch({ type: "transcript-append", line: MESSAGE, role });
  }
  await flush();

  stdin.write("x".repeat(inputLength));
  await flush();

  // Warm-up: absorb the first few backspaces' one-time costs (e.g. cliCursor.hide's first write)
  // before the counters below start, so the measured window only reflects steady-state cost.
  //
  // 60ms between keystrokes, not a tighter spacing: InputBox's own THROTTLE_MS (50ms) coalesces
  // several rapid keystrokes into one flush/frame, which would make `n` backspaces produce far
  // fewer than `n` real frames — measured directly against an earlier draft of this harness at
  // 10ms spacing, where 20 backspaces produced only ~5 real frames and silently diluted the
  // per-row byte metric below by that same ~4x factor. 60ms clears the 50ms throttle window, so
  // each backspace gets its own flush and `n` is an accurate frame count for the metric below.
  for (let i = 0; i < 5; i++) {
    stdin.write("\x7f");
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  stdout.bytes = 0;
  stdout.writes = 0;
  stdout.raw = "";

  for (let i = 0; i < n; i++) {
    stdin.write("\x7f");
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  instance.unmount();
  return { bytes: stdout.bytes, writes: stdout.writes, raw: stdout.raw };
}

describe("TUI input render cost", () => {
  // theme.userBg's opening truecolor background code — colorize.js (via chalk.bgHex) is what
  // emits this, and output.js only keeps a padded row's trailing spaces when the row carries an
  // SGR like this one (see the file-level comment on `chalk.level` above).
  const USER_BG_SGR = "\x1b[48;2;51;51;51m";

  // Metric: marginal bytes written to stdout per visible role:"user" transcript row, per
  // keystroke. Two runs, identical terminal geometry and message text, differing only in role
  // mix (all-"system" vs all-"user"): `pushLine` (reducer.ts) inserts a blank role:"system"
  // separator before every role:"user" turn but the first, so `seedCount` user dispatches yield
  // `2 * seedCount - 1` transcript rows — only `seedCount` of which are actually role:"user".
  // `rows` is generous enough that every seeded row stays inside the viewport (asserted below),
  // so `visibleUserRows` is exactly `seedCount`, not an estimate.
  test("a visible user-role transcript row costs its message width per keystroke, not the full terminal width", async () => {
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

    // Negative control: without a real SGR in the captured bytes, the byte comparison below would
    // pass for the wrong reason (nothing in either run costs any color at all).
    expect(userRun.raw).toContain(USER_BG_SGR);

    expect(2 * seedCount - 1).toBeLessThanOrEqual(rows); // sanity: nothing scrolled out of view
    const visibleUserRows = seedCount;

    const marginal = (userRun.bytes - systemRun.bytes) / (n * visibleUserRows);

    // Threshold, derived not tuned. theme.userBg's fixed SGR overhead is 21 bytes (open
    // "\x1b[48;2;51;51;51m", 16 bytes, + close "\x1b[49m", 5 bytes). Every seeded row here uses
    // the identical MESSAGE text, so `messageWidth` cancels out of the user/system diff and
    // `marginal` reduces to SGR_OVERHEAD + (bandWidth - messageWidth): pre-fix the band is
    // `columns` (100) wide regardless of message length, measured at 88 bytes/row/keystroke on
    // this machine; post-fix the band is at most the widest visible message — `messageWidth`
    // itself here — collapsing the formula to just SGR_OVERHEAD (measured at 21). SLACK=10 keeps
    // this threshold (64) roughly centred between the two, not hugging either one: 24 bytes of
    // headroom against the pre-fix value, 43 against the post-fix one.
    const SGR_OVERHEAD = 21;
    const messageWidth = stringWidth(MESSAGE);
    const SLACK = 10;

    expect(marginal).toBeLessThan(SGR_OVERHEAD + messageWidth + SLACK);
  });
});
