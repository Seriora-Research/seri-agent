/** @jsxImportSource @opentui/react */
// Measures what a keystroke actually costs to write to the terminal, not what it costs to
// compute. `@opentui/core/testing`'s own `createTestRenderer` defaults to `bufferedOutput:
// "memory"` (frames kept in-memory only, for `captureCharFrame()`), which bypasses the exact
// diff-and-write path this file measures — passing a real `stdout` stream alongside an explicit
// `bufferedOutput: "stdout"` override makes the renderer allocate a real `NativeSpanFeed` and pipe
// actual diffed ANSI bytes through it (confirmed empirically against this exact harness: a plain
// `<text bg="#333333">` mount produces the real truecolor SGR on the provided stream), the same
// path `runTui`'s own real terminal mount uses.

import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../../src/tui/app";
import { MAIN_TUI_RENDERER_CONFIG } from "../../src/tui/runtime/renderOptions";
import type { TuiAction } from "../../src/tui/state/reducer";
import type { TranscriptRole } from "../../src/tui/util/format";
import { flush, route, session } from "./helpers";

// FakeTty's own fixed column width — matches this file's own assumption that width doesn't vary
// across these tests. Named and exported-in-scope rather than inlined so the marginal-bytes
// threshold below can derive from the same value instead of hardcoding a number that would
// silently drift out of sync with it.
const TEST_COLUMNS = 100;

// A fake TTY stdout: fixed `TEST_COLUMNS` columns, a configurable row count, and counters for
// every byte/call written to it — the thing a real terminal emulator has to parse and repaint.
// `raw` accumulates the actual written text (not just its length) so a test can assert on the
// bytes' own content, not only their count.
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

// A realistic short user turn — 33 display cells, a representative short user turn.
const MESSAGE = "> how do I refactor this function";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mounts <App> through OpenTUI's real interactive render path (`bufferedOutput: "stdout"`, above),
// seeds `seedCount` transcript rows of a fixed `role` (all the same `MESSAGE` text, so only the
// role differs between two runs), types a fixed-length input, then does N backspaces and reports
// the bytes/writes that cost the terminal.
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
    // Spread first, not last: this test's own explicit options below (width/height/stdout/
    // bufferedOutput) are what this suite actually depends on, so a future key added to the shared
    // `MAIN_TUI_RENDERER_CONFIG` const can't silently override one of them.
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
      reasoningEffortDefault={undefined}
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

  // Everything written up to here (mount, seed, initial type) — the one place the transcript's own
  // user-row band actually gets painted (see the file-level comment on why the MEASURED window
  // below never touches it at all).
  const setupRaw = stdout.raw;

  // Warm-up: absorb the first few backspaces' one-time costs (e.g. the renderer's own initial
  // cursor/alt-screen setup bytes, already written before this point, plus any first-repaint-only
  // cost) before the counters below start, so the measured window only reflects steady-state cost.
  //
  // 60ms between keystrokes, not a tighter spacing: InputBox's own THROTTLE_MS (50ms) coalesces
  // several rapid keystrokes into one flush/frame, which would make `n` backspaces produce far
  // fewer than `n` real frames — measured directly against an earlier draft of this harness at a
  // tighter spacing, where the per-row byte metric below was silently diluted by the same
  // coalescing factor. 60ms clears the 50ms throttle window, so each backspace gets its own flush
  // and `n` is an accurate frame count for the metric below.
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
  // theme.userBg's opening truecolor background code — the same SGR chunk's own file-level comment
  // above confirms lands on a real provided stdout stream once `bufferedOutput: "stdout"` is set.
  const USER_BG_SGR = "\x1b[48;2;51;51;51m";

  // This scenario changes meaning under OpenTUI, not just its harness (worth recording explicitly,
  // per this migration's own test-plan: a scenario that no longer applies as originally framed
  // should say so rather than being silently force-fit). The ORIGINAL Ink-era regression this
  // guarded against was specific to `log-update`'s own repaint model: Ink re-diffs and rewrites
  // full STRING lines on every frame, so a `theme.userBg` band that was accidentally
  // `TEST_COLUMNS`-wide (instead of message-width) cost real bytes on every single keystroke, not
  // just once. OpenTUI's renderer is a native CELL-level diffing buffer — a backspace in InputBox
  // only ever dirties the input row's own cells; the transcript's user-row band is never
  // re-examined by a keystroke at all, confirmed empirically against this exact harness (the raw
  // bytes captured during the backspace loop below contain no transcript-region content, styled or
  // not, regardless of `role`). There is consequently no per-keystroke cost left for a wide
  // user-band to inflate — the property worth guarding is now "editing the input box costs the
  // same regardless of the transcript's role mix," a stronger, renderer-appropriate form of the
  // same underlying concern. The band-WIDTH correctness itself (the fix this file originally
  // shipped alongside) is covered independently by App.test.tsx's own test asserting the
  // user-message band's background color and its shrink-to-content width directly against a
  // rendered frame's captured spans.
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

    // Negative control: without a real SGR anywhere in the user run's setup, the byte-equality
    // check below would pass for the wrong reason (this fixture never actually rendered a
    // user-styled row to begin with).
    expect(userRun.setupRaw).toContain(USER_BG_SGR);
    expect(systemRun.setupRaw).not.toContain(USER_BG_SGR);

    expect(2 * seedCount - 1).toBeLessThanOrEqual(rows); // sanity: nothing scrolled out of view

    // `writes` guards against the exact dilution this file's own 60ms-spacing comment above
    // documents: at a tighter spacing, several keystrokes coalesce into one flush/frame, so far
    // fewer than `n` real frames land and the byte-equality check below is computed against a
    // shrunken, coincidentally-still-equal sample without anything here noticing. Every real
    // (non-coalesced) frame writes to `stdout` at least once, so if all `n` backspaces got their
    // own frame, `writes` is at least `n`.
    expect(userRun.writes).toBeGreaterThanOrEqual(n);
    expect(systemRun.writes).toBeGreaterThanOrEqual(n);

    // The actual property: identical byte-for-byte, not just "close" — a native diffing renderer's
    // repaint of the input row alone (cursor position, the row's own characters) does not depend on
    // what the transcript above it contains, so nothing here should differ between the two runs.
    expect(userRun.bytes).toBe(systemRun.bytes);
    expect(userRun.raw).toBe(systemRun.raw);
  });
});
