/** @jsxImportSource @opentui/react */

import { afterEach, describe, expect, test } from "bun:test";
import { parseColor, RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import type { ReactElement, ReactNode } from "react";
import type { PermissionMode } from "../../src/gate/gate";
import type { ApprovalAnswer } from "../../src/loop/loop";
import type { ChildEventPayload } from "../../src/subagents/dispatch";
import { App, type AppProps } from "../../src/tui/app";
import { childWindowOffset } from "../../src/tui/components/SubagentPanel";
import type { ConfigRow, ModelPickerEntry, SetupProviderRow } from "../../src/tui/state/commands";
import type { Dispatch } from "../../src/tui/state/reducer";
import { ARCHIVIST_MARK, theme } from "../../src/tui/theme/theme";
import { ListRow } from "../../src/tui/ui/ListRow";
import {
  DEFAULT_COLUMNS,
  formatContextWindow,
  formatCost,
  formatModelRow,
  formatRouteLabel,
  formatSetupRow,
  listWindowSize,
  MODE_CYCLE_HINT,
  MODE_HINT_COLS,
  MODE_LABEL,
  matchesFilter,
  singleLine,
  slideWindow,
} from "../../src/tui/util/format";
import { catalogEntry, catalogOf, flush, flushMarkdown, route, session } from "./helpers";

// Wide enough that every formatModeDetail tier, including the route label (>=MODE_ROUTE_MIN_COLS,
// 100 cols), is exercised by default,
// tall enough (>=24 rows) that every panel's own list window sits at LIST_WINDOW_MAX (10) without
// each test having to resize just to clear that floor (util/format.ts's own PANEL_CHROME_ROWS/
// APP_CHROME_ROWS math: listWindowSize(height - 14), which reaches 10 at height >= 24). Deliberately
// fixed rather than inherited from the real host terminal — a test's expected geometry should not
// depend on the terminal it happens to run in.
const DEFAULT_WIDTH = 100;
const DEFAULT_HEIGHT = 30;

// Every `connect()` call creates a real `CliRenderer` instance, which registers its own listener
// on the process-wide `TerminalConsoleCache` singleton on construction — this file's own test
// count (140+) crosses Node's default 10-listener warning threshold if nothing ever tears one
// down. `afterEach` destroys whatever this test's own `connect()` call created, not a broader
// process-wide listener-count override, so a real leak elsewhere would still surface.
const mountedRenderers: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of mountedRenderers.splice(0)) {
    setup.renderer.destroy();
  }
});

async function mount(setup: TestRendererSetup, node: ReactNode): Promise<void> {
  createRoot(setup.renderer).render(node);
  await flush(setup);
}

// Two `flush()` calls (4 settle passes), not one: a resize that changes the transcript viewport's
// own measured height chains two separate commits — the terminal-dimensions state update, then the
// transcript box's own `onSizeChange` firing off THAT re-render's new layout — and a single
// `flush()` only reliably observes the first. Verified empirically against this exact scenario (a
// resize expected to grow the visible transcript window stayed one `flush()` short of the fully
// resized frame; a second call reliably completed it).
async function resize(setup: TestRendererSetup, width: number, height: number): Promise<void> {
  setup.resize(width, height);
  await flush(setup);
  await flush(setup);
}

async function connect(
  overrides: Partial<AppProps> = {},
): Promise<{ setup: TestRendererSetup; dispatch: Dispatch }> {
  let dispatch: Dispatch | undefined;
  const setup = await createTestRenderer({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  mountedRenderers.push(setup);
  await mount(
    setup,
    <App
      session={session()}
      route={route()}
      catalog={undefined}
      config={{}}
      // Before `{...overrides}` so a test can still pass `onSubmit: undefined` to mount the
      // pre-session state (the splash/guided-setup shape). The default mount here is a live
      // session, which is what every other test in this file assumes.
      onSubmit={() => {}}
      {...overrides}
      connectDispatch={(d) => {
        dispatch = d;
        overrides.connectDispatch?.(d);
      }}
    />,
  );
  // `mount`'s own `flush` is a fixed 2 passes — `connectDispatch` fires from a `useEffect`, whose
  // own commit can land later than that under CPU contention (confirmed live: intermittent CI
  // failures with "connectDispatch never fired" on otherwise-unmodified runs). `waitFor` retries
  // against the renderer's own scheduler state instead of a blind pass count, and is a no-op if
  // `dispatch` is already set by the time it's called.
  await setup.waitFor(() => dispatch !== undefined);
  if (dispatch === undefined) throw new Error("connectDispatch never fired");
  return { setup, dispatch };
}

// Named-key sequences this file drives directly (not covered by mockInput's own named helpers) —
// the exact bytes OpenTUI's keypress parser maps to "home"/"end"/"delete"/"pageup" (confirmed
// against @opentui/core's own parser table), the same sequences the old ink-testing-library
// harness wrote to stdin for the same keys.
const HOME = "HOME";
const END = "END";
const DELETE_KEY = "DELETE";
const PAGE_UP = "\x1b[5~";
const SHIFT_TAB = "\x1b[Z";

describe("App", () => {
  test("renders the mode indicator for the session's permission mode", async () => {
    const { setup } = await connect({ session: session({ permissionMode: "read-only" }) });
    expect(setup.captureCharFrame()).toContain("⏸ read-only mode on");
  });

  // InputBox is the only bordered element visible at this default state (the test right below
  // this one), so its bottom "─" rule is a unique, safe anchor for InputBox's own position.
  test("the mode row renders below the input box, not above it", async () => {
    const { setup } = await connect({ session: session({ permissionMode: "read-only" }) });
    const lines = setup.captureCharFrame().split("\n");
    const modeLineIndex = lines.findIndex((l) => l.includes("read-only mode on"));
    const inputBottomBorderIndex = lines.reduce((last, l, i) => (l.includes("─") ? i : last), -1);
    // The comment above asserts InputBox is the only bordered element here — assert it, not just
    // narrate it, or a future border elsewhere silently degrades this into "the mode line exists."
    expect(inputBottomBorderIndex).toBeGreaterThan(-1);
    expect(modeLineIndex).toBeGreaterThan(inputBottomBorderIndex);
  });

  // `not.toContain("╭")` is what makes this non-vacuous across all 9 borderStyle sites at once —
  // a stray "rounded" reintroduced anywhere would still leave a rounded corner present elsewhere on
  // screen. `"─"`, not `"┌"`: InputBox (the only bordered element visible at this default state)
  // borders top/bottom only now — `border={["top", "bottom"]}` drops its corner glyphs entirely,
  // not just its side rules.
  test("borders render with square corners, not rounded ones", async () => {
    const { setup } = await connect();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("─");
    expect(frame).not.toContain("╭");
  });

  // InputBox (components/InputBox.tsx) borders top/bottom only — `border={["top", "bottom"]}`
  // drops both the vertical side rules and every corner glyph, not just the sides.
  test("InputBox has a top/bottom horizontal rule only — no vertical sides, no corner glyphs", async () => {
    const { setup } = await connect();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("─");
    expect(frame).not.toContain("│");
    expect(frame).not.toContain("┌");
    expect(frame).not.toContain("┐");
    expect(frame).not.toContain("└");
    expect(frame).not.toContain("┘");
  });

  // `onSubmit` is only wired once a session exists (runTui, cli.ts); the splash and guided-setup
  // mounts (routes/setup/) render this same component with nothing behind it. An InputBox rendered
  // there echoes everything typed at it and drops it on Enter, so a task typed during the seconds
  // between dismissing the splash and the session mounting vanishes and the run sits idle forever
  // with no spinner and no error.
  test("an App with nowhere to send input does not echo what is typed at it", async () => {
    const { setup } = await connect({ onSubmit: undefined });
    // A second flush before typing, and a real wait after it, for the two reasons
    // inputBox.test.tsx's own harness documents: `useKeyboard` subscribes from a passive effect
    // that needs one more settled pass than mount, and InputBox's own 50ms throttle holds
    // everything after the leading-edge keystroke behind a pending timer.
    await flush(setup);
    await setup.mockInput.typeText("Reply with exactly the word PROBE");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await flush(setup);

    expect(setup.captureCharFrame()).not.toContain("PROBE");
  });

  test("an App with nowhere to send input says the session is still starting", async () => {
    const { setup } = await connect({ onSubmit: undefined });
    expect(setup.captureCharFrame()).toContain("starting session");
  });

  test("a command-error dispatch renders the ErrorLine mark and message", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "command-error", message: "boom" });
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("✕ ");
    expect(frame).toContain("boom");
  });

  // Re-test of ui/ErrorLine.tsx's own truncate-with-multiple-children fix (see that file's
  // comment, mirroring ui/ListRow.tsx's own): a message wider than the row must clip to one row,
  // not soft-wrap across several — every caller (app.tsx's own APP_CHROME_ROWS, each panel's own
  // budget) reserves exactly one row for this line, so a wrap here would push whatever sits below
  // it (here, InputBox) past its own expected row.
  test("a long command-error message stays on one row instead of wrapping across several", async () => {
    const { setup, dispatch } = await connect();

    dispatch({
      type: "command-error",
      message: "x".repeat(DEFAULT_WIDTH + 5),
    });
    await flush(setup);

    const frame = setup.captureCharFrame();
    const overflowRows = frame.split("\n").filter((line) => line.includes("xxxxx"));
    expect(overflowRows).toHaveLength(1);
  });

  test("a transcript-append dispatch grows the transcript viewport", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "transcript-append", line: "Session s1: permission mode is now auto" });
    await flush(setup);

    expect(setup.captureCharFrame()).toContain("Session s1: permission mode is now auto");
  });

  // TranscriptRow's own user-role band: theme.userBg's background color, shrunk to the message's
  // own content width (`alignSelf="flex-start"`) rather than stretched across the transcript's full
  // width.
  test("a user-message entry gets theme.userBg's background band, shrunk to its own content width", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "transcript-append", line: "hi", role: "user" });
    await flush(setup);

    const frame = setup.captureSpans();
    const line = frame.lines.find((l) => l.spans.some((s) => s.text.includes("hi")));
    expect(line).toBeDefined();
    const span = line?.spans.find((s) => s.text.includes("hi"));
    expect(span?.bg.equals(RGBA.fromHex(theme.userBg))).toBe(true);
    expect(span?.width).toBeLessThan(DEFAULT_WIDTH);
  });

  // Regression guard: the deleted `transcriptRowsProps` (format.ts) explicitly measured this band's
  // width in a wide-character-aware way — an ASCII-only test can't tell a correct measurement from
  // one that silently counts wide characters as 1 cell each, so this pins the same band assertion
  // against 4 CJK characters, each 2 display cells wide (8 total, not 4).
  test("a user-message entry with CJK content gets a band sized to its own display width, not char count", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "transcript-append", line: "你好世界", role: "user" });
    await flush(setup);

    const frame = setup.captureSpans();
    const line = frame.lines.find((l) => l.spans.some((s) => s.text.includes("你")));
    const span = line?.spans.find((s) => s.text.includes("你"));
    expect(span?.bg.equals(RGBA.fromHex(theme.userBg))).toBe(true);
    expect(span?.width).toBe(8);
  });

  // Regression guard: `pushLine`'s own blank `{role: "system", text: ""}` separator (reducer.ts)
  // between turns depended, pre-migration, on `wrapForTranscript` guaranteeing an empty string
  // survives as exactly one visual row — that guarantee has no reducer-side equivalent anymore, it's
  // entirely on `<text>` collapsing an empty string to one row rather than zero height. Two known
  // one-line entries with exactly one row between them pins that this still holds.
  test("the blank separator between turns still renders as its own row, not collapsed to nothing", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "transcript-append", line: "first turn", role: "user" });
    await flush(setup);
    dispatch({ type: "transcript-append", line: "second turn", role: "user" });
    await flush(setup);

    const lines = setup.captureCharFrame().split("\n");
    const firstIndex = lines.findIndex((l) => l.includes("first turn"));
    const secondIndex = lines.findIndex((l) => l.includes("second turn"));
    expect(secondIndex).toBe(firstIndex + 2);
  });

  // Tail-anchored, not head-anchored — 300 lines is comfortably more than the fixed test viewport's
  // row count, so the viewport MUST be showing a slice, and that slice must be the newest end.
  test("a transcript longer than the viewport shows the newest line and hides the oldest, with InputBox still visible", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("line 299");
    expect(frame).not.toContain("line 0");
    // InputBox's own top/bottom border rule — proves the viewport left room for the live region
    // below it rather than consuming the whole frame.
    expect(frame).toContain("─");
  });

  test("PageUp shows the scrolled indicator and reveals an older line; End clears it and returns to the newest", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush(setup);
    expect(setup.captureCharFrame()).not.toContain("↑ scrolled");

    setup.mockInput.pressKey(PAGE_UP);
    await flush(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("↑ scrolled — End to follow");
    expect(frame).not.toContain("line 299");

    setup.mockInput.pressKey(END);
    await flush(setup);
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("↑ scrolled");
    expect(frame).toContain("line 299");
  });

  // Regression guard: the scrollbox's own mouse-wheel handling moves its real scroll position
  // independently of the keyboard handler that used to be the only place `scrolledUp` was set, so a
  // wheel-up scroll used to move the viewport away from the tail with no banner ever appearing to
  // explain why.
  test("scrolling up with the mouse wheel shows the scrolled indicator", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush(setup);
    expect(setup.captureCharFrame()).not.toContain("↑ scrolled");

    for (let i = 0; i < 10; i++) {
      await setup.mockMouse.scroll(5, 5, "up");
    }
    await flush(setup);

    expect(setup.captureCharFrame()).toContain("↑ scrolled — End to follow");
  });

  // Regression guard: a resize that grows the viewport enough for all content to fit re-engages
  // `stickyStart="bottom"` (ScrollBoxRenderable's own `recalculateBarProps`) with no keypress of the
  // user's own — the banner has to clear from that same real scroll-position change, not just from
  // an explicit Home/End/PageUp/PageDown press.
  test("growing the terminal enough for all content to fit clears a stale scrolled indicator", async () => {
    const { setup, dispatch } = await connect();
    await resize(setup, DEFAULT_WIDTH, 10);

    for (let i = 0; i < 20; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush(setup);

    setup.mockInput.pressKey(HOME);
    await flush(setup);
    expect(setup.captureCharFrame()).toContain("↑ scrolled");

    await resize(setup, DEFAULT_WIDTH, 60);

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("↑ scrolled");
    expect(frame).toContain("line 19");
  });

  // Regression guard: PageUp/PageDown/Home/End used to fire regardless of which render-ternary
  // branch was active, mutating transcriptScrollOffset in the background while a modal panel
  // (here /config) fully occluded the transcript. Closing the panel would then reveal a
  // transcript scrolled up with no visible keypress of the user's own against it to explain why.
  test("PageUp while a modal panel is open does not scroll the transcript in the background", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    dispatch({
      type: "config-requested",
      rows: [
        {
          key: "SERI_VERIFY_ENABLED",
          masked: "",
          source: "unset",
          removable: false,
          kind: "boolean",
          on: true,
        },
      ],
    });
    await flush(setup);

    setup.mockInput.pressKey(PAGE_UP);
    await flush(setup);
    expect(setup.captureCharFrame()).not.toContain("↑ scrolled");

    dispatch({ type: "config-resolved" });
    await flush(setup);
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("↑ scrolled");
    expect(frame).toContain("line 299");
  });

  // Regression guard (found independently by two automated PR reviewers): `transcriptScrollOffset`
  // used to be re-clamped only inside the `transcript-scroll`/`transcript-scroll-to` actions
  // themselves, both fired only by a keypress — a terminal resize that GROWS the viewport fires
  // neither, so a scrolled-up offset stayed pinned to the height the viewport had when it was set,
  // and `visibleTranscript` kept showing exactly that many lines instead of growing to fill the
  // taller box. Scrolling to the very top makes this observable without depending on the exact
  // chrome-row math: the highest line number shown must increase once the terminal grows, since
  // more of the already-loaded transcript becomes visible below the fixed top edge.
  test("a resize while scrolled to the top reveals more of the transcript, not a static slice", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush(setup);
    setup.mockInput.pressKey(HOME);
    await flush(setup);

    const highestLineShown = (frame: string) =>
      Math.max(...[...frame.matchAll(/line (\d+)/g)].map((m) => Number(m[1])));
    const highestBefore = highestLineShown(setup.captureCharFrame());

    await resize(setup, DEFAULT_WIDTH, 40);

    expect(highestLineShown(setup.captureCharFrame())).toBeGreaterThan(highestBefore);
  });

  // Regression guard: `maxScrollTop = scrollHeight - viewport.height` only ever GROWS on a shrink
  // (a smaller viewport can't lower how much content is scrollable), so there is no clamp-down case
  // here the way a grow has (`maxScrollTop` shrinking below the current `scrollTop`, covered above)
  // — this instead pins the weaker but still real property a shrink needs: the scrolled-to-top view
  // renders valid, uncorrupted content and the banner stays correct, not a blanked/garbled frame.
  test("a resize that shrinks the terminal while scrolled to the top still shows valid content", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush(setup);
    setup.mockInput.pressKey(HOME);
    await flush(setup);
    expect(setup.captureCharFrame()).toContain("line 0");

    await resize(setup, DEFAULT_WIDTH, 10);
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("line 0");
    expect(frame).toContain("↑ scrolled");
  });

  // Regression guard (found by review): before `visibleTranscript`/the scroll clamp derived visual
  // rows from `state.transcript` on read (format.ts's own `transcriptVisualRows`), a single streamed
  // answer with embedded newlines committed as ONE transcript array entry — the clamp's `max` was
  // always <= 0 regardless of how many rows that one entry actually needed, so PageUp/Home could
  // never move the offset at all and whatever the box couldn't fit was silently clipped by
  // `overflow="hidden"` with no way to reach it. 300 lines, not a small number: on a tall terminal
  // a short answer can fit entirely without the bug ever being exercised, which is exactly why a
  // short version of this test can pass on a broken build. `"answer line 0"` alone doesn't prove
  // reachability either — `overflow="hidden"` clips from the TOP, so line 0 is the one line a broken
  // build already keeps; the tail (`"answer line 299"`) is the one only the fix can reach.
  test("a single answer with more lines than the viewport is fully reachable by scrolling, not silently dropped", async () => {
    const { setup, dispatch } = await connect();

    const answer = Array.from({ length: 300 }, (_, i) => `answer line ${i}`).join("\n");
    dispatch({ type: "transcript-append", line: answer });
    await flush(setup);

    expect(setup.captureCharFrame()).toContain("answer line 299");

    setup.mockInput.pressKey(HOME);
    await flush(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("answer line 0");
    expect(frame).toContain("↑ scrolled");
  });

  // No transcript row is ever produced from `state.streaming` while a turn is active — the reveal
  // is buffer-then-commit, not incremental, so a scrolled-up reader can never catch a glimpse of
  // partial text regardless of how many `text-delta` chunks arrive or where they scroll to.
  test("no partial assistant text renders while a turn is active, scrolled up or following the tail", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
    await flush(setup);

    setup.mockInput.pressKey(PAGE_UP); // scroll away from the tail
    await flush(setup);
    expect(setup.captureCharFrame()).toContain("↑ scrolled");
    for (let i = 0; i < 5; i++) {
      dispatch({ type: "loop-event", event: { type: "text-delta", text: `chunk ${i}\n` } });
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("chunk");
    }

    setup.mockInput.pressKey(END); // back to following the tail
    await flush(setup);
    for (let i = 5; i < 10; i++) {
      dispatch({ type: "loop-event", event: { type: "text-delta", text: `chunk ${i}\n` } });
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("chunk");
    }
  });

  // Home dispatched while a turn is active reaches the oldest COMMITTED row — there is no
  // in-progress answer for it to reveal any part of, partial or otherwise.
  test("Home pressed while a turn is active shows only committed rows and TurnStatus, never the in-progress answer", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
    const answer = Array.from({ length: 300 }, (_, i) => `answer line ${i}`).join("\n");
    dispatch({ type: "loop-event", event: { type: "text-delta", text: answer } });
    await flush(setup);

    setup.mockInput.pressKey(HOME);
    await flush(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("line 0");
    expect(frame).toContain("↑ scrolled");
    expect(frame).not.toContain("answer line");
  });

  // Same scenario, but with genuine growth after Home is pressed — confirms further streamed
  // chunks never leak into the frame either, and the committed view stays anchored on "line 0".
  test("more text streaming in after Home is pressed mid-turn still shows no partial answer", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
    await flush(setup);

    setup.mockInput.pressKey(HOME);
    await flush(setup);
    expect(setup.captureCharFrame()).toContain("line 0");

    for (let i = 0; i < 10; i++) {
      dispatch({ type: "loop-event", event: { type: "text-delta", text: `\nmore ${i}` } });
      await flush(setup);
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("more ");
      expect(frame).toContain("line 0");
    }
  });

  // The reveal contract's other half: nothing shows while streaming, but the full response commits
  // in one frame the instant the turn's terminal event fires — no partial-then-complete transition
  // visible across two frames.
  test("the full response appears atomically in TurnStatus's place once the turn's done event fires", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
    const answer = Array.from({ length: 5 }, (_, i) => `answer line ${i}`).join("\n");
    dispatch({ type: "loop-event", event: { type: "text-delta", text: answer } });
    await flush(setup);
    expect(setup.captureCharFrame()).not.toContain("answer line 0");

    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    await flushMarkdown(
      setup,
      (frame) => frame.includes("answer line 0") && frame.includes("answer line 4"),
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("answer line 0");
    expect(frame).toContain("answer line 4");
  });

  // The reveal's lossless guarantee: the committed entry is the exact concatenation of every
  // `text-delta` chunk dispatched during the turn, including a word split across a chunk boundary
  // ("wor" + "ld") — reducer.ts's own `state.streaming + event.text` accumulation, proven at the
  // rendered-frame level since nothing exposes `state` directly from this harness.
  test("the flushed transcript entry is byte-identical to the full concatenation of every text-delta sent during the turn", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
    const chunks = ["Hello, wor", "ld! The quick brown fox jumps ", "over the lazy dog."];
    for (const chunk of chunks) {
      dispatch({ type: "loop-event", event: { type: "text-delta", text: chunk } });
    }
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    const full = chunks.join("");
    await flushMarkdown(setup, (frame) => frame.includes(full));

    expect(setup.captureCharFrame()).toContain(full);
  });

  // Acceptance criterion: `TurnStatus` is mounted inside the transcript box (after the committed
  // rows), not in the status-bar row alongside the mode indicator.
  test("TurnStatus renders as the last line of the transcript box, not the status-bar row", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "transcript-append", line: "hello" });
    dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 3 });
    await flush(setup);

    const lines = setup.captureCharFrame().split("\n");
    const helloIndex = lines.findIndex((line) => line.includes("hello"));
    const modeLabelIndex = lines.findIndex((line) => line.includes("approve-each mode on"));
    const turnStatusIndex = lines.findIndex((line) => line.includes(" ↑, ") && line.includes(" ↓"));

    expect(helloIndex).toBeGreaterThanOrEqual(0);
    expect(modeLabelIndex).toBeGreaterThan(helloIndex);
    expect(turnStatusIndex).toBeGreaterThan(helloIndex);
    expect(turnStatusIndex).toBeLessThan(modeLabelIndex);
    expect(lines[modeLabelIndex]).not.toContain(" ↑, ");
  });

  // Scroll-anchor coverage for the native `<scrollbox>` `stickyScroll`/`stickyStart="bottom"` (no
  // reducer-computed `transcriptScrollOffset` behind it anymore). Five invariants below, re-verified
  // directly against the scrollbox's own behavior since none of them are guarded by reducer state
  // anymore (the mechanisms that used to enforce them — `transcriptScrollOffset`,
  // `reservedTranscriptRows`'s own +1/-1 nudge — no longer exist; the native scrollbox owns
  // scroll-anchor behavior entirely on its own now).
  //
  // Negative control, verified once rather than per-test: removing `stickyScroll
  // stickyStart="bottom"` from app.tsx's `<scrollbox>` fails the two tests below that assert
  // "follows the newest line" (the follow-tail half of the guarantee) — confirming those two
  // actually exercise the native sticky behavior rather than passing vacuously. The "holds position
  // once scrolled up" tests pass either way: with no reducer-side nudge math left to remove (the
  // OLD design's own `turn-started`/`turn-ended` offset adjustments no longer exist at all), there
  // is nothing left in this codebase that COULD move a scrolled-up view out from under a reader —
  // these pin that absence directly rather than needing a contrived way to reintroduce it.
  describe("scrollbox stickyScroll invariants", () => {
    test("stays on the newest line while new content keeps arriving at the bottom", async () => {
      const { setup, dispatch } = await connect();

      for (let i = 0; i < 50; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("line 49");

      for (let i = 50; i < 60; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("line 59");
      expect(setup.captureCharFrame()).not.toContain("↑ scrolled");
    });

    // Regression guard: `scrollboxHeight` shrinks by one row the same render TurnStatus mounts
    // (app.tsx) — a reader following the live tail when a turn starts must still see the newest
    // line, not have it pushed out of view for a frame by that same-render height change.
    test("starting a turn while following the tail keeps the newest line visible", async () => {
      const { setup, dispatch } = await connect();

      for (let i = 0; i < 50; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("line 49");

      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("line 49");
      expect(setup.captureCharFrame()).not.toContain("↑ scrolled");
    });

    test("holds position once scrolled up, even as new content keeps arriving", async () => {
      const { setup, dispatch } = await connect();

      for (let i = 0; i < 50; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);
      setup.mockInput.pressKey(HOME);
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("line 0");
      expect(setup.captureCharFrame()).toContain("↑ scrolled");

      for (let i = 50; i < 60; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("line 0");
      expect(setup.captureCharFrame()).not.toContain("line 59");
      expect(setup.captureCharFrame()).toContain("↑ scrolled");
    });

    // Invariant: /clear while scrolled up drops the "↑ scrolled" banner instead of leaving it
    // stuck on an empty transcript — app.tsx's own `scrolledUp` sync settles this through the same
    // `layout-changed` listener a resize uses, no transcript-length special case needed.
    test("transcript-cleared while scrolled up drops the scrolled-up banner", async () => {
      const { setup, dispatch } = await connect();

      for (let i = 0; i < 50; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);
      setup.mockInput.pressKey(HOME);
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("↑ scrolled");

      dispatch({ type: "transcript-cleared" });
      // Two passes, not one: the shrink's own "layout-changed" fires with a stale scrollTop before
      // the scrollbox's internal clamp catches up, so the first pass's `sync` (app.tsx) can compute
      // a spurious `scrolledUp: true` from mismatched old/new dimensions — the second pass's
      // `layout-changed`, firing once Yoga has fully settled, corrects it.
      await flush(setup);
      await flush(setup);

      expect(setup.captureCharFrame()).not.toContain("↑ scrolled");
    });

    // Invariant: a mid-turn flush (a tool-call/tool-result/etc, not a bare
    // transcript-append) must not move a scrolled-up reader's view.
    test("a mid-turn flush does not move a scrolled-up reader's view", async () => {
      const { setup, dispatch } = await connect();

      for (let i = 0; i < 50; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      await flush(setup);
      setup.mockInput.pressKey(HOME);
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("line 0");

      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
      });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("line 0");
      expect(setup.captureCharFrame()).toContain("↑ scrolled");
    });

    // Invariant: starting a turn does not itself move a scrolled-up reader's view (the old
    // reducer's own +1 nudge for TurnStatus's reserved row no longer exists — TurnStatus renders as
    // a fixed sibling below the scrollbox now, with the scrollbox giving up one row of height for
    // it, so a scrolled-up view is untouched by a turn starting).
    test("turn-started does not move a scrolled-up reader's view", async () => {
      const { setup, dispatch } = await connect();

      for (let i = 0; i < 50; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);
      setup.mockInput.pressKey(HOME);
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("line 0");

      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("line 0");
      expect(setup.captureCharFrame()).toContain("↑ scrolled");
    });

    // Invariant: ending a turn does not move a scrolled-up reader's view either (the
    // mirror-image -1 release no longer exists for the same reason).
    test("turn-ended does not move a scrolled-up reader's view", async () => {
      const { setup, dispatch } = await connect();

      for (let i = 0; i < 50; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      await flush(setup);
      setup.mockInput.pressKey(HOME);
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("line 0");

      dispatch({ type: "turn-ended" });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("line 0");
      expect(setup.captureCharFrame()).toContain("↑ scrolled");
    });

    // Invariant: a resize while scrolled up reveals more of the transcript instead of a
    // static slice — covered directly by "a resize while scrolled to the top reveals more of the
    // transcript, not a static slice" above; not duplicated here.

    // Invariant: duplicate/out-of-order turn-lifecycle dispatches (a bare turn-ended with
    // no turn ever started, or two turn-started in a row) cannot corrupt the view — there is no
    // scroll-related reducer state left for them to corrupt at all (reducer.test.ts's own former "a
    // duplicate turn-ended with no active turn leaves a valid offset untouched" test covered the
    // OLD reducer's equivalent state; this pins the render-visible behavior on the new model
    // instead, since there is no analogous reducer field left to assert on).
    test("duplicate/out-of-order turn-lifecycle dispatches do not move a scrolled-up reader's view", async () => {
      const { setup, dispatch } = await connect();

      for (let i = 0; i < 50; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);
      setup.mockInput.pressKey(HOME);
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("line 0");

      // A duplicate turn-ended with no turn ever started.
      dispatch({ type: "turn-ended" });
      // Two turn-started in a row with no turn-ended between them.
      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("line 0");
      expect(setup.captureCharFrame()).toContain("↑ scrolled");
    });

    // TurnStatus (a fixed sibling row below the scrollbox while a turn is active) stays visible as
    // more committed content arrives, because the scrollbox gives up one row of height for it.
    test("TurnStatus stays visible below the scrollbox while committed content keeps arriving", async () => {
      const { setup, dispatch } = await connect();

      for (let i = 0; i < 50; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      await flush(setup);
      expect(setup.captureCharFrame()).toMatch(/\d+s .*↑, .*↓/);

      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
      });
      await flush(setup);

      expect(setup.captureCharFrame()).toMatch(/\d+s .*↑, .*↓/);
    });

    // Acceptance criterion: TurnStatus stays visually pinned to the transcript's last line while a
    // turn is active, regardless of scroll position — the reader can be looking at the oldest line
    // in the transcript and still see the running turn's own elapsed-time/token indicator.
    test("TurnStatus stays visible while scrolled away from the tail during an active turn", async () => {
      const { setup, dispatch } = await connect();

      for (let i = 0; i < 50; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      await flush(setup);

      setup.mockInput.pressKey(HOME);
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("line 0");

      expect(setup.captureCharFrame()).toMatch(/\d+s .*↑, .*↓/);
    });

    // Regression: `scrollboxHeight` used to floor at 1, not 0 — on a terminal short enough that
    // `transcriptHeight` itself is already the 1-row floor, that claimed the one row TurnStatus
    // needs for the scrollbox instead, clipping TurnStatus to nothing during an active turn.
    test("TurnStatus stays visible during an active turn even on a terminal too short for the transcript too", async () => {
      const { setup, dispatch } = await connect();
      await resize(setup, DEFAULT_WIDTH, 5);

      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      await flush(setup);

      expect(setup.captureCharFrame()).toMatch(/\d+s .*↑, .*↓/);
    });
  });

  // An assistant entry with every markdown feature TranscriptRow supports actually renders as
  // styled/structured output via <markdown>, not raw markdown syntax as text.
  test("an assistant entry with bold/header/list/link/fenced-code/table renders via <markdown>, not raw syntax", async () => {
    const { setup, dispatch } = await connect();

    const answer = [
      "# Heading",
      "",
      "**bold text** and a [link](https://example.com)",
      "",
      "- item one",
      "- item two",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| cellx | celly |",
    ].join("\n");
    dispatch({ type: "loop-event", event: { type: "text-delta", text: answer } });
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    // Every block's own prose, not just the last one dispatched: `<markdown>`'s content tree does
    // NOT settle top-to-bottom — probed directly, the table (the last block in source order) can
    // render before the heading (the first) does, so polling on any single block risks reading a
    // still-partially-built frame as done.
    await flushMarkdown(
      setup,
      (frame) =>
        frame.includes("Heading") &&
        frame.includes("bold text") &&
        frame.includes("item one") &&
        frame.includes("celly"),
    );

    const frame = setup.captureCharFrame();
    // The raw markdown syntax markers themselves are gone — conceal (MarkdownOptions' own default)
    // strips them once parsed, unlike a plain <text> (the old rendering path), which would show
    // them verbatim.
    expect(frame).not.toContain("# Heading");
    expect(frame).not.toContain("**bold text**");
    expect(frame).not.toContain("[link](https://example.com)");
    expect(frame).not.toContain("```");
    // The actual prose content still renders.
    expect(frame).toContain("Heading");
    expect(frame).toContain("bold text");
    expect(frame).toContain("link");
    expect(frame).toContain("item one");
    expect(frame).toContain("item two");
    expect(frame).toContain("const x = 1;");
    expect(frame).toContain("cellx");
    expect(frame).toContain("celly");
  });

  // Archivist report is a secondary system note (muted + leading mark, no assistant ●) whose
  // summary is painted through the same <markdown> path as the assistant branch — conceal must
  // strip ** rather than leaving the markers as literal text. Stats stay a separate plain line
  // so "(archivist: …)" is never fed to the markdown parser.
  test("an archivist stats+summary block is muted with a leading mark and conceals markdown markers", async () => {
    const { setup, dispatch } = await connect();

    dispatch({
      type: "transcript-append",
      line: `${ARCHIVIST_MARK}(archivist: tool-count trigger, 1 tool call)`,
      muted: true,
    });
    dispatch({
      type: "transcript-append",
      line: "recorded **bold** fact",
      muted: true,
      markdown: true,
    });
    await flush(setup);
    await flushMarkdown(setup, (frame) => frame.includes("recorded") && frame.includes("bold"));

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("**");
    expect(frame).toContain("bold");
    expect(frame).toContain(ARCHIVIST_MARK);
    expect(frame).toContain("(archivist:");
    const archivistLines = frame
      .split("\n")
      .filter(
        (line) =>
          line.includes("(archivist:") || line.includes("recorded") || line.includes("bold"),
      );
    expect(archivistLines.length).toBeGreaterThan(0);
    for (const line of archivistLines) {
      expect(line.trimStart().startsWith("●")).toBe(false);
    }
    const spans = setup.captureSpans();
    const statsLine = spans.lines.find((l) => l.spans.some((s) => s.text.includes("(archivist:")));
    const statsSpan = statsLine?.spans.find((s) => s.text.includes("(archivist:"));
    expect(statsSpan, "no span found containing (archivist:").toBeDefined();
    expect(statsSpan?.fg.equals(parseColor(theme.muted))).toBe(true);
    const summaryLine = spans.lines.find((l) => l.spans.some((s) => s.text.includes("bold")));
    const summarySpan = summaryLine?.spans.find((s) => s.text.includes("bold"));
    if (summarySpan) {
      expect(summarySpan.fg.equals(parseColor(theme.muted))).toBe(true);
    }
  });

  test("a normal system line is not markdown-parsed and is not forced muted", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "transcript-append", line: "boom **not-bold**" });
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("**not-bold**");
    const spans = setup.captureSpans();
    const line = spans.lines.find((l) => l.spans.some((s) => s.text.includes("**not-bold**")));
    const span = line?.spans.find((s) => s.text.includes("**not-bold**"));
    expect(span, "no span found containing **not-bold**").toBeDefined();
    expect(span?.fg.equals(parseColor(theme.text))).toBe(true);
    expect(span?.fg.equals(parseColor(theme.muted))).toBe(false);
  });

  // resolveTableRenderableOptions()/createTextTableRenderable() in the installed @opentui/core
  // build never forwarded the markdown renderable's own fg, so a table cell fell back to
  // TextTableRenderable's hardcoded white default instead of theme.text. Header cells need their
  // own case (not just an inference from the data-cell one) because createTableHeaderCellChunks
  // re-maps every chunk's fg through headingStyle.fg ?? chunk.fg — a distinct code path. Bold
  // cells need their own case too: createChunk's precedence rule (getStyle(group) ||
  // getStyle("default")) means a bold chunk's own scope ("markup.strong") short-circuits before
  // ever reaching "default", which is the case that falsifies an app-side "default"-scope-only
  // fix (that fix would still leave styled cell content white).
  const TABLE_CELL_COLOR_CASES = [
    {
      name: "data cell",
      rows: ["| a | b |", "| - | - |", "| cellx | celly |"],
      settleOn: "celly",
      target: "cellx",
    },
    {
      name: "header cell",
      rows: ["| hdrx | hdry |", "| - | - |", "| cellx | celly |"],
      settleOn: "celly",
      target: "hdrx",
    },
    {
      name: "bold data cell",
      rows: ["| a | b |", "| - | - |", "| **boldcell** | plaincell |"],
      settleOn: "plaincell",
      target: "boldcell",
    },
    {
      name: "bold header cell",
      rows: ["| **boldhdr** | hdry |", "| - | - |", "| cellx | celly |"],
      settleOn: "celly",
      target: "boldhdr",
    },
  ];
  test.each(TABLE_CELL_COLOR_CASES.map((c) => [c.name, c] as const))(
    "a markdown table's %s renders theme.text, not white",
    async (name, { rows, settleOn, target }) => {
      const { setup, dispatch } = await connect();
      const answer = rows.join("\n");
      dispatch({ type: "loop-event", event: { type: "text-delta", text: answer } });
      dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
      await flush(setup);
      await flushMarkdown(setup, (frame) => frame.includes(settleOn));

      const frame = setup.captureSpans();
      const line = frame.lines.find((l) => l.spans.some((s) => s.text.includes(target)));
      const span = line?.spans.find((s) => s.text.includes(target));
      expect(span, `${name}: no span found containing "${target}"`).toBeDefined();
      expect(span?.fg.equals(parseColor(theme.text))).toBe(true);
    },
    10_000,
  );

  // Regression: ordinary multi-line prose with no long tokens at all used to clip to one visual
  // row — broader than the long-token case below, and the case that actually revealed the bug, so
  // it's asserted on its own rather than relying on the long-token test alone.
  test("a long multi-line assistant message wraps across rows instead of clipping to one", async () => {
    const { setup, dispatch } = await connect();
    await resize(setup, 30, DEFAULT_HEIGHT);

    const answer = Array(30).fill("word").join(" ");
    dispatch({ type: "loop-event", event: { type: "text-delta", text: answer } });
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    await flushMarkdown(setup, (frame) => (frame.match(/word/g) ?? []).length === 30);

    expect((setup.captureCharFrame().match(/word/g) ?? []).length).toBe(30);
  });

  // Regression: a single token too long for one row (a bare unbroken run, no code-span markup)
  // used to clip past its tail — asserting the FULL token, not just its tail, since a clipped
  // prefix with an intact tail would otherwise still pass.
  test("a long inline-code token that overflows one row still shows in full on wrapped lines", async () => {
    const { setup, dispatch } = await connect();
    await resize(setup, 30, DEFAULT_HEIGHT);

    const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    const answer = "`" + token + "`";
    dispatch({ type: "loop-event", event: { type: "text-delta", text: answer } });
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    await flushMarkdown(setup, (frame) => frame.includes(token.slice(-10)));

    const rendered = setup.captureCharFrame().replace(/\s+/g, "");
    expect(rendered).toContain(token);
  });

  // Same regression, issue #161's own literal report: a long bare URL with no code-span markup at
  // all — the unbroken-token case most likely to actually appear in a real response.
  test("a long bare URL that overflows one row still shows in full on wrapped lines", async () => {
    const { setup, dispatch } = await connect();
    await resize(setup, 30, DEFAULT_HEIGHT);

    const url = "https://example.com/some/very/long/path/segment/wider/than/the/terminal";
    dispatch({ type: "loop-event", event: { type: "text-delta", text: url } });
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    await flushMarkdown(setup, (frame) => frame.includes(url.slice(-10)));

    const rendered = setup.captureCharFrame().replace(/\s+/g, "");
    expect(rendered).toContain(url);
  });

  // Negative control: content that already fit on one row before the fix must still render on
  // EXACTLY that one row after it (not merely "a matching row exists somewhere") — guards against
  // an off-by-one from `<markdown>`'s own `paddingLeft` AND asserts the scrollbox's separate
  // `paddingLeft={1}` actually reaches this row (the bullet lands at column 1, not column 0).
  test("a short assistant message that fits on one row renders unchanged", async () => {
    const { setup, dispatch } = await connect();
    await resize(setup, 30, DEFAULT_HEIGHT);

    dispatch({ type: "loop-event", event: { type: "text-delta", text: "hi there" } });
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    await flushMarkdown(setup, (frame) => frame.includes("hi there"));

    const lines = setup.captureCharFrame().split("\n");
    const contentLines = lines.filter((line) => line.includes("hi there"));
    expect(contentLines).toHaveLength(1);
    expect(contentLines[0]?.indexOf("●")).toBe(1);
    expect(contentLines[0]?.trimStart().startsWith("● hi there")).toBe(true);
  });

  // Bullet-placement invariant TranscriptRow's own comment requires: a fixed row prefix, not
  // repeated or lost mid-wrap — checked for both a wrapped and a single-row message. Two full
  // connect()+flushMarkdown() cycles in one test, each with its own up-to-3000ms settle budget
  // (helpers.ts's own flushMarkdown comment) — given an explicit timeout above bun's 5000ms
  // default so a slow runner reports THIS test's real failure instead of bun's own generic
  // "test timed out" swallowing it.
  test("exactly one ● bullet renders, at the start of the block's first row, wrapped or not", async () => {
    const assertBulletInvariant = (frame: string) => {
      expect((frame.match(/●/g) ?? []).length).toBe(1);
      const bulletLine = frame.split("\n").find((line) => line.includes("●"));
      expect(bulletLine?.trimStart().startsWith("●")).toBe(true);
    };

    const wrapped = await connect();
    await resize(wrapped.setup, 30, DEFAULT_HEIGHT);
    const answer = Array(30).fill("word").join(" ");
    wrapped.dispatch({ type: "loop-event", event: { type: "text-delta", text: answer } });
    wrapped.dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(wrapped.setup);
    await flushMarkdown(wrapped.setup, (frame) => (frame.match(/word/g) ?? []).length === 30);
    assertBulletInvariant(wrapped.setup.captureCharFrame());

    const singleRow = await connect();
    singleRow.dispatch({ type: "loop-event", event: { type: "text-delta", text: "hi there" } });
    singleRow.dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(singleRow.setup);
    await flushMarkdown(singleRow.setup, (frame) => frame.includes("hi there"));
    assertBulletInvariant(singleRow.setup.captureCharFrame());
  }, 10_000);

  // Resize re-flow: a message wrapped at a narrow width re-flows onto fewer rows once the
  // terminal widens, with no stale wrapped line left over from the narrower layout. The post-resize
  // `flushMarkdown` predicate requires the row count to have actually DROPPED below `narrowRows`,
  // not just that all 30 words are still present — the word-count condition alone was already true
  // before the resize, so a predicate that only re-checked it could return the moment the resize
  // dispatch lands, before Yoga's own re-layout pass has actually run, and read `wideRows` off a
  // stale narrow-layout frame. Explicit timeout: two flushMarkdown calls in one test, same margin
  // reasoning as the bullet-invariant test above.
  test("a wrapped message re-flows onto fewer rows when the terminal widens", async () => {
    const { setup, dispatch } = await connect();
    await resize(setup, 30, DEFAULT_HEIGHT);

    const answer = Array(30).fill("word").join(" ");
    dispatch({ type: "loop-event", event: { type: "text-delta", text: answer } });
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    await flushMarkdown(setup, (frame) => (frame.match(/word/g) ?? []).length === 30);
    const narrowRows = setup
      .captureCharFrame()
      .split("\n")
      .filter((line) => line.includes("word")).length;

    await resize(setup, 100, DEFAULT_HEIGHT);
    await flushMarkdown(setup, (frame) => {
      const rows = frame.split("\n").filter((line) => line.includes("word")).length;
      return (frame.match(/word/g) ?? []).length === 30 && rows < narrowRows;
    });
    const frame = setup.captureCharFrame();
    const wideRows = frame.split("\n").filter((line) => line.includes("word")).length;

    expect(wideRows).toBeLessThan(narrowRows);
    expect((frame.match(/●/g) ?? []).length).toBe(1);
  }, 10_000);

  // Regression: without an in-flow bullet sibling, the assistant row's height comes from
  // `<markdown>` alone (TranscriptRow's own `minHeight={1}` comment) — a whitespace-only entry
  // (reachable: state/reducer.ts's `pushLine` flushes on `state.streaming.length > 0`, which
  // whitespace satisfies) used to make the whole row, bullet included, disappear instead of
  // rendering a blank line the way the old row-flex layout did for free.
  test("a whitespace-only assistant message still renders its bullet", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "loop-event", event: { type: "text-delta", text: "\n" } });
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    await flushMarkdown(setup, (frame) => frame.includes("●"));

    expect((setup.captureCharFrame().match(/●/g) ?? []).length).toBe(1);
  });

  // Regression: the scrollbox's cosmetic paddingLeft/paddingRight stacked with the assistant row's
  // own bullet gutter left too little content width at a narrow terminal for `<markdown>` to
  // render at all (confirmed empirically down to width 4-5, fine again from width 6) — below
  // TRANSCRIPT_PADDING_MIN_WIDTH the margin is dropped so content still renders. Width 5 here is
  // comfortably under that threshold and was one of the confirmed-broken widths.
  test("a narrow terminal still renders assistant content once the transcript margin drops", async () => {
    const { setup, dispatch } = await connect();
    await resize(setup, 5, DEFAULT_HEIGHT);

    dispatch({ type: "loop-event", event: { type: "text-delta", text: "hi" } });
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    await flushMarkdown(setup, (frame) => frame.includes("hi"));

    const bulletLine = setup
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("●"));
    expect(bulletLine?.indexOf("●")).toBe(0);
  });

  // A transcript shorter than the viewport renders from the top of the scrollbox's own content
  // flow (a column-direction box's children always stack top-down, with no bottom-anchoring prop
  // needed) instead of bottom-padding a mostly-empty screen — the appended content must land near
  // the very top of the frame, not down near InputBox.
  test("a short transcript top-anchors: content appears near the top of the frame, not bottom-padded", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "transcript-append", line: "hello" });
    await flush(setup);

    const lines = setup.captureCharFrame().split("\n");
    const contentIndex = lines.findIndex((line) => line.includes("hello"));
    expect(contentIndex).toBeGreaterThanOrEqual(0);
    expect(contentIndex).toBeLessThan(3);
  });

  // A committed assistant answer's own first visual row is prefixed with the `●` marker
  // (TranscriptRow, app.tsx) — applied at render time, never stored on the entry itself.
  test("a committed assistant answer's frame line starts with the ● marker", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "loop-event", event: { type: "text-delta", text: "the answer" } });
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    await flushMarkdown(setup, (frame) => frame.includes("the answer"));

    const lines = setup.captureCharFrame().split("\n");
    expect(lines.some((line) => line.trimStart().startsWith("● the answer"))).toBe(true);
  });

  test("a tool-call loop-event sets the running status, and tool-result clears it", async () => {
    const { setup, dispatch } = await connect();

    dispatch({
      type: "loop-event",
      event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
    });
    await flush(setup);
    expect(setup.captureCharFrame()).toContain("Running read_file…");

    dispatch({
      type: "loop-event",
      event: { type: "tool-result", name: "read_file", result: "ok" },
    });
    await flush(setup);
    expect(setup.captureCharFrame()).not.toContain("Running read_file…");
    expect(setup.captureCharFrame()).not.toContain("→ read_file");
  });

  test("session-updated refreshes the mode indicator shown", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "session-updated", session: session({ permissionMode: "auto" }) });
    await flush(setup);

    expect(setup.captureCharFrame()).toContain("⏵⏵ bypass permissions on");
  });

  // A paste arrives as its own bracketed-paste event under OpenTUI (InputBox.tsx's own comment),
  // never through the keyboard handler — unlike Ink, which handed a paste to `useInput` as
  // one oversized `input` chunk indistinguishable from typed keys. A pasted chunk with an embedded
  // real `\r`/`\n` must still submit at the first line rather than embedding the terminator
  // literally, the same contract `usePaste`'s own terminator-split implements.
  test("a pasted chunk with an embedded newline submits at the first line, not silently swallowing it", async () => {
    const submitted: string[] = [];
    const { setup } = await connect({ onSubmit: (v) => submitted.push(v) });

    await setup.mockInput.pasteBracketedText("first line\nsecond line");
    await flush(setup);

    expect(submitted).toEqual(["first line"]);
    expect(setup.captureCharFrame()).toContain("second line");
  });

  // MEDIUM-4: a `\r\n` pair (a Windows-clipboard paste) is ONE terminator — stripping only the
  // `\r` would leave a stray leading `\n` in the retained input.
  test("a pasted chunk with a CRLF terminator does not leave a stray newline in the retained input", async () => {
    const submitted: string[] = [];
    const { setup } = await connect({ onSubmit: (v) => submitted.push(v) });

    await setup.mockInput.pasteBracketedText("first line\r\nsecond line");
    await flush(setup);

    expect(submitted).toEqual(["first line"]);
    // Not `\nsecond line` — the retained value itself is asserted (not just the frame's rendering,
    // which could hide a stray `\n` some other way) via a second Enter that only submits "second
    // line" cleanly if `after` was exactly that, with no leading control byte.
    setup.mockInput.pressEnter();
    await flush(setup);
    expect(submitted).toEqual(["first line", "second line"]);
  });

  // Required #4 (thermo-nuclear structural review): the pending-tool live region used a raw
  // JSON.stringify on `args` with no cap, unlike cli.ts's own approval prompt, which already uses
  // truncateArgsDisplay for the exact same reason (write_file's args carry a whole file body,
  // which can otherwise scroll the box itself out of view). pendingTool is set only for
  // write_file/edit, so those are the only tool-call names that populate it.
  test("the pending-tool box truncates a long write_file body instead of rendering it in full", async () => {
    const { setup, dispatch } = await connect();

    dispatch({
      type: "loop-event",
      event: {
        type: "tool-call",
        name: "write_file",
        args: { path: "a.txt", content: "x".repeat(300) },
      },
    });
    await flush(setup);

    // "…)" specifically, not a bare "…": the reducer's own status line ("Running write_file…")
    // already contains an ellipsis unconditionally, on both the truncated and untruncated
    // renders — that alone doesn't distinguish them. The truncated render's own trailing "…)" —
    // the ellipsis immediately followed by the closing paren truncateArgsDisplay's own output sits
    // inside — only exists once truncation actually ran.
    expect(setup.captureCharFrame()).toContain("…)");
  });

  // The deliberate exception: a routine in-flight write_file/edit display is not an alert, so it
  // gets neither WARNING_MARK nor bold. Without this, a later well-meaning "consistency" edit could
  // silently reclassify a routine event as one.
  test("the pending-tool box carries no warning mark — it is not an alert", async () => {
    const { setup, dispatch } = await connect();

    dispatch({
      type: "loop-event",
      event: { type: "tool-call", name: "write_file", args: { path: "a.txt", content: "x" } },
    });
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("write_file(");
    expect(frame).not.toContain("! write_file");
  });

  // Non-write tools use an unbordered theme.muted live line, not the write_file/edit bordered box.
  test("a pending read_file call renders an unbordered muted line, not a bordered box", async () => {
    const { setup, dispatch } = await connect();

    dispatch({
      type: "loop-event",
      event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
    });
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Read a.txt");
    expect(frame).not.toContain("read_file(");
    const spans = setup.captureSpans();
    const line = spans.lines.find((l) => l.spans.some((s) => s.text.includes("Read a.txt")));
    const span = line?.spans.find((s) => s.text.includes("Read a.txt"));
    expect(span, "no span found containing Read a.txt").toBeDefined();
    expect(span?.fg.equals(parseColor(theme.muted))).toBe(true);
  });

  function countNeedle(frame: string, needle: string): number {
    return frame.split(needle).length - 1;
  }

  function bashOk() {
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    };
  }

  describe("live aggregated tool activity", () => {
    test("after a read_file result and before done, the frame shows the compact settled line", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-result", name: "read_file", result: "ok" },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Read a.txt");
      expect(frame).not.toContain("Running read_file…");
      expect(frame).not.toContain("(done:");
      const spans = setup.captureSpans();
      const line = spans.lines.find((l) => l.spans.some((s) => s.text.includes("Read a.txt")));
      const span = line?.spans.find((s) => s.text.includes("Read a.txt"));
      expect(span, "no span found containing Read a.txt").toBeDefined();
      expect(span?.fg.equals(parseColor(theme.muted))).toBe(true);
    });

    test("two sequential same-name read_file results before done show one Read 2 files", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-result", name: "read_file", result: "ok" },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "read_file", args: { path: "b.txt" } },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-result", name: "read_file", result: "ok" },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(countNeedle(frame, "Read 2 files")).toBe(1);
      expect(frame).not.toContain("Read a.txt");
      expect(frame).not.toContain("Read b.txt");
      expect(frame).not.toContain("(done:");
    });

    // In-place aggregation is every TOOL_LABELS name, not a Read special-case.
    test("two sequential same-name bash results before done show one Ran 2 shell commands", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "bash", args: { command: "echo a" } },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-result", name: "bash", result: bashOk() },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "bash", args: { command: "echo b" } },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-result", name: "bash", result: bashOk() },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(countNeedle(frame, "Ran 2 shell commands")).toBe(1);
      expect(frame).not.toContain("Ran echo a");
      expect(frame).not.toContain("Ran echo b");
      expect(frame).not.toContain("(done:");
    });

    test("grep then read_file before done shows two live groups", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "grep", args: { pattern: "TODO" } },
      });
      dispatch({
        type: "loop-event",
        event: {
          type: "tool-result",
          name: "grep",
          result: { mode: "files_with_matches", files: ["a.ts"], truncated: false },
        },
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("Searched TODO");

      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-result", name: "read_file", result: "ok" },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Searched TODO");
      expect(frame).toContain("Read a.txt");
      expect(frame).not.toContain("(done:");
    });

    test("after done, Read 2 files appears once from the flushed transcript", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-result", name: "read_file", result: "ok" },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "read_file", args: { path: "b.txt" } },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-result", name: "read_file", result: "ok" },
      });
      dispatch({
        type: "loop-event",
        event: { type: "done", reason: "no-tool-call" },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(countNeedle(frame, "Read 2 files")).toBe(1);
      expect(frame).toContain("done");
    });

    test("a mid-turn error does not flush; live paint still shows the settled group", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
      });
      dispatch({
        type: "loop-event",
        event: { type: "tool-result", name: "read_file", result: "ok" },
      });
      dispatch({
        type: "loop-event",
        event: { type: "error", error: "compaction failed" },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Read a.txt");
      expect(frame).toContain("compaction failed");
      expect(frame).not.toContain("(done:");
    });
  });

  // Ctrl-D calls the onQuit prop directly — app.tsx wires it through to InputBox unconditionally,
  // so this is the same trigger runTui's own quit() attaches to.
  test("Ctrl-D calls onQuit", async () => {
    let quit = false;
    const { setup } = await connect({ onQuit: () => (quit = true) });

    setup.mockInput.pressKey("d", { ctrl: true });
    await flush(setup);

    expect(quit).toBe(true);
  });

  // Findings 1+5 (thermo-nuclear structural review, round 6): the TUI-native approval prompt —
  // the ORIGINAL research-spec design ("a TUI supplies a different function of the identical
  // signature... with zero change to loop.ts/gate.ts") that every earlier round of this branch
  // left unbuilt.
  describe("approval prompt", () => {
    test("renders in place of the input box, matching makeApprovalPrompt's own prompt text", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: { path: "a.txt", content: "x" },
        offersAlways: true,
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      // Split across two checks, not one long toContain: the box wraps this line across its own
      // bordered rows, the same wrapping every other long-line assertion in this file already
      // works around.
      expect(frame).toContain(
        `Approve write_file({"path":"a.txt","content":"x"})? [y]es / [a]lways (saved for this project) /`,
      );
      expect(frame).toContain("[N]o");
      // Pins both WARNING_MARK and that it sits immediately before the shared helper's own output.
      expect(frame).toContain("! Approve write_file");
    });

    test("y answers 'once', a answers 'always' when offered, and anything else (n, Enter, an unoffered a) answers 'no'", async () => {
      const answers: ApprovalAnswer[] = [];
      const { setup, dispatch } = await connect({ onApprovalAnswer: (a) => answers.push(a) });

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush(setup);
      setup.mockInput.pressKey("y");
      await flush(setup);
      expect(answers).toEqual(["once"]);

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush(setup);
      setup.mockInput.pressKey("a");
      await flush(setup);
      expect(answers).toEqual(["once", "always"]);

      // Not offered this time — "a" falls through to "no", the same "anything unrecognised is
      // 'no'" rule makeApprovalPrompt itself applies.
      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: false,
      });
      await flush(setup);
      setup.mockInput.pressKey("a");
      await flush(setup);
      expect(answers).toEqual(["once", "always", "no"]);

      // Enter defaults to "no" — the bracketed capital in "[N]o".
      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);
      expect(answers).toEqual(["once", "always", "no", "no"]);
    });

    // Mutual exclusivity (app.tsx's own comment): while an approval is pending, InputBox is not
    // mounted at all, so ordinary typing does not reach onSubmit — it reaches ApprovalBox's own
    // handler instead, which (per the test above) answers "no" for anything that isn't y/a/Enter.
    test("input while an approval is pending does not reach onSubmit", async () => {
      const submitted: string[] = [];
      const answers: ApprovalAnswer[] = [];
      const { setup, dispatch } = await connect({
        onSubmit: (v) => submitted.push(v),
        onApprovalAnswer: (a) => answers.push(a),
      });

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush(setup);
      // A single keystroke, not a multi-character chunk: this is only about confirming the
      // keypress reached ApprovalBox instead of InputBox.
      setup.mockInput.pressKey("h");
      await flush(setup);

      expect(submitted).toEqual([]);
      // Not y/a/Enter — resolved "no", confirming the keystroke was consumed by ApprovalBox.
      expect(answers).toEqual(["no"]);
    });

    // A navigation/editing key carries no printable `sequence` at all, unlike an ordinary "wrong"
    // letter — ApprovalBox's own guard (`!isPrintableKey(key)`, util/keys.ts) is what makes it a
    // no-op rather than falling into the "anything unrecognised is 'no'" catch-all meant for
    // actual mistyped text.
    test("navigation and editing keys (arrow, backspace) are ignored rather than treated as an implicit deny", async () => {
      const answers: ApprovalAnswer[] = [];
      const { setup, dispatch } = await connect({ onApprovalAnswer: (a) => answers.push(a) });

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush(setup);

      setup.mockInput.pressArrow("up");
      await flush(setup);
      setup.mockInput.pressBackspace();
      await flush(setup);
      expect(answers).toEqual([]);

      // Still live, not wedged: an actual keystroke still resolves it.
      setup.mockInput.pressKey("y");
      await flush(setup);
      expect(answers).toEqual(["once"]);
    });
  });

  // ListRow (ui/ListRow.tsx) has no hooks, so calling it directly (not mounting it) is safe: its
  // return value is a plain element tree whose props reflect exactly what it would render.
  // Selection is reverse video (Design conformance, docs/design/tui.md), spelled as an explicit
  // `theme.selectedFg` on `theme.selectedBg` — `captureCharFrame()` carries no attribute/color
  // info (the same limitation the old harness's `lastFrame()` had for the reverse-video row), so
  // this is the one place that pins the actual style props rather than just the "> "/"  " marker.
  describe("ListRow", () => {
    // The regression this exists for: the row used to carry `TextAttributes.INVERSE` and no colors
    // at all, and OpenTUI 0.5.6 renders INVERSE by emitting a background equal to the cell's own
    // foreground — so every selected row painted a solid block with its text invisible inside it.
    // Asserting the two tokens is not enough on its own to catch that class of bug coming back;
    // asserting they are DIFFERENT is, which is why the inequality is spelled out rather than left
    // implied by the token values.
    test("a selected row paints selectedFg on selectedBg, two colors that must never be equal", () => {
      const selected = ListRow({ selected: true, label: "x" }) as ReactElement<{
        backgroundColor: string | undefined;
        children: ReactElement<{ fg: string | undefined; bg: string | undefined }>[];
      }>;
      const [marker, label] = selected.props.children;

      expect(selected.props.backgroundColor).toBe(theme.selectedBg);
      for (const node of [marker, label]) {
        expect(node?.props.fg).toBe(theme.selectedFg);
        expect(node?.props.bg).toBe(theme.selectedBg);
        expect(node?.props.fg).not.toBe(node?.props.bg);
      }
    });

    test("an unselected row sets no colors of its own, so it inherits ordinary row styling", () => {
      const unselected = ListRow({ selected: false, label: "x" }) as ReactElement<{
        backgroundColor: string | undefined;
        children: ReactElement<{
          fg: string | undefined;
          bg: string | undefined;
          children: string;
        }>[];
      }>;
      const [marker, label] = unselected.props.children;

      expect(unselected.props.backgroundColor).toBeUndefined();
      expect(marker?.props.children).toBe("  ");
      for (const node of [marker, label]) {
        expect(node?.props.fg).toBeUndefined();
        expect(node?.props.bg).toBeUndefined();
      }
    });

    test("the marker is a sibling text node carrying the same selection colors as the label", () => {
      const selected = ListRow({ selected: true, label: "x" }) as ReactElement<{
        children: ReactElement<{ children: string }>[];
      }>;
      expect(selected.props.children[0]?.props.children).toBe("> ");
      expect(selected.props.children[1]?.props.children).toBe("x");
    });
  });

  describe("welcome splash", () => {
    // ListRow always applies `truncate`: before this, WelcomeSplash's own row carried no wrap prop
    // at all, so a label wider than the terminal soft-wrapped onto a second row instead of
    // truncating — this pins both halves, the marker at a normal width and the truncation at a
    // narrow one. OpenTUI's native `truncate` clips with a middle ellipsis (verified: "Continue
    // without logging in" becomes "Continue...ogging in" at width 24, not an end-truncated
    // "Continue without…"), so the narrow-width half checks that the middle of the label — not
    // just any substring of it — is the part that's gone, rather than asserting exact ellipsis
    // placement.
    test("rows carry the ListRow marker, and truncate rather than wrap at a narrow width", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "splash-requested" });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("> Log in");

      await resize(setup, 24, DEFAULT_HEIGHT);

      const narrowFrame = setup.captureCharFrame();
      // "Continu", not "Continue": the panel's own one-column left/right padding
      // (WelcomeSplashPanel.tsx) costs the label two columns, and at width 24 the middle ellipsis
      // eats one more character of the head than it used to. The claim this test makes is
      // unchanged — the MIDDLE of the label is what goes, not an arbitrary substring.
      expect(narrowFrame).toContain("Continu");
      expect(narrowFrame).not.toContain("without");
    });

    // Pins the fix for a real regression: `ui/ListRow.tsx`'s own `<text truncate>` on the row
    // label did not actually suppress wrapping without also pinning `wrapMode="none"` on the label
    // and `flexShrink={0}` on the marker (see that file's own comment) — "Continue without logging
    // in" used to wrap across two rows instead of truncating to one line with an ellipsis,
    // reproducing the exact symptom the ORIGINAL Ink-era fix (this describe block's own header
    // comment) closed.
    // The intro block the splash exists to show (routes/setup/SplashBanner.tsx). Asserted through
    // App rather than by mounting SplashBanner directly, because the thing that actually broke
    // before was the wiring: App has to forward `splashBanner` to a panel that only renders it on
    // the splash branch.
    test("the banner names the product, version, model and directory", async () => {
      const { setup, dispatch } = await connect({
        splashBanner: {
          version: "0.4.2",
          model: "openai/gpt-oss-120b",
          provider: "groq",
          cwd: "/home/lion/code/seri",
          home: "/home/lion",
        },
      });

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "splash-requested" });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("seri v0.4.2");
      expect(frame).toContain("openai/gpt-oss-120b · groq");
      expect(frame).toContain("~/code/seri");
      expect(frame).toContain("> Log in");
    });

    // The banner outlives the splash: dismissing the menu must not take the header with it. Codex
    // keeps its own session header as the first history cell for the same reason, and this pins
    // the two halves that make it behave that way — it renders on a live session (no
    // `splash-requested` here), and it sits ABOVE the transcript so conversation pushes it up.
    test("the banner holds the top of the transcript on a live session", async () => {
      const { setup, dispatch } = await connect({
        splashBanner: {
          version: "0.4.2",
          model: "openai/gpt-oss-120b",
          provider: "groq",
          cwd: "/home/lion/code/seri",
          home: "/home/lion",
        },
      });

      dispatch({ type: "transcript-append", role: "system", line: "Session s1 created." });
      await flush(setup);

      const lines = setup.captureCharFrame().split("\n");
      const bannerIndex = lines.findIndex((l) => l.includes("seri v0.4.2"));
      const createdIndex = lines.findIndex((l) => l.includes("Session s1 created."));
      expect(bannerIndex).toBeGreaterThanOrEqual(0);
      expect(lines[bannerIndex + 2]).toContain("~/code/seri");
      expect(bannerIndex).toBeLessThan(createdIndex);
    });

    // The pre-session window used to render a dead placeholder, so a task typed while
    // `prepareSession` was still running was lost. These pin both halves: the box takes the line,
    // and the second one goes away so a second line cannot silently replace the first.
    test("a task typed before the session exists is handed to the caller", async () => {
      const taken: string[] = [];
      const { setup, dispatch } = await connect({
        onSubmit: undefined,
        onPreSessionSubmit: (task) => taken.push(task),
      });

      dispatch({ type: "splash-resolved" });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("starting session");

      setup.mockInput.typeText("fix the wrap");
      setup.mockInput.pressEnter();
      await flush(setup);

      expect(taken).toEqual(["fix the wrap"]);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("queued");
      expect(frame).toContain("fix the wrap");
    });

    test("the box is withdrawn after one task, so a second cannot replace it", async () => {
      const taken: string[] = [];
      const { setup, dispatch } = await connect({
        onSubmit: undefined,
        onPreSessionSubmit: (task) => taken.push(task),
      });

      dispatch({ type: "splash-resolved" });
      await flush(setup);
      setup.mockInput.typeText("first");
      setup.mockInput.pressEnter();
      await flush(setup);
      setup.mockInput.typeText("second");
      setup.mockInput.pressEnter();
      await flush(setup);

      expect(taken).toEqual(["first"]);
      expect(setup.captureCharFrame()).not.toContain("second");
    });

    // The splash mount's own first frame lands before `connectDispatch` fires `splash-requested`,
    // so `pendingSplash` is false there too. Without the `splashDone` latch that frame offered a
    // live input box, and a fast typist could queue a task before answering the login gate.
    test("no input box before the login choice is answered", async () => {
      const taken: string[] = [];
      const { setup } = await connect({
        onSubmit: undefined,
        onPreSessionSubmit: (task) => taken.push(task),
      });

      setup.mockInput.typeText("too early");
      setup.mockInput.pressEnter();
      await flush(setup);

      expect(taken).toEqual([]);
      expect(setup.captureCharFrame()).not.toContain("too early");
    });

    // Without onPreSessionSubmit the mount keeps the inert placeholder it always had — the guided
    // setup has no session coming and nothing to hand a task to.
    test("a mount with no pre-session handler keeps the inert placeholder", async () => {
      const { setup } = await connect({ onSubmit: undefined });

      setup.mockInput.typeText("dropped");
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("starting session");
      expect(frame).not.toContain("dropped");
    });

    // A mount with no banner is the test-only shape (WelcomeSplashPanel's own `banner?` comment) —
    // pinned so it degrades to the bare wordmark instead of throwing on an undefined field.
    test("a mount with no banner still renders the menu", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "splash-requested" });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("> Log in");
    });

    test("WelcomeSplashPanel's long row truncates to one line rather than wrapping at a narrow width", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "splash-requested" });
      await flush(setup);

      await resize(setup, 24, DEFAULT_HEIGHT);

      expect(setup.captureCharFrame()).not.toContain("logging in");
    });
  });

  describe("model picker", () => {
    function entry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
      return {
        id: "llama-3.3-70b-versatile",
        provider: "groq",
        displayName: "Llama 3.3 70B",
        family: "llama",
        contextWindow: 131_072,
        maxOutputTokens: 32_768,
        toolCall: true,
        reasoning: false,
        pricing: undefined,
        ...overrides,
      };
    }

    function row(overrides: Partial<ModelCatalogEntry> = {}): ModelPickerEntry {
      return {
        entry: entry(overrides),
        keyConfigured: true,
        alternatives: 0,
        gatewayReachable: false,
      };
    }

    test("renders in place of the input box once requested", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "model-picker-requested", entries: [row()] });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("Llama 3.3 70B");
    });

    test("shows a placeholder hint before typing, and hides it once a filter is typed", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "model-picker-requested", entries: [row()] });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain('Type to filter — try "free" or "paid"…');

      await setup.mockInput.typeText("8b");
      await flush(setup);

      expect(setup.captureCharFrame()).not.toContain('Type to filter — try "free" or "paid"…');
    });

    // Pins the fix for a real regression, not a test-harness bug (confirmed against a direct mount
    // at width 42 with no resize involved at all — and against `modelPicker.test.tsx`'s own re-test
    // loop, which never exercised this because it always types a filter first, so
    // `showPlaceholder` is never true there): with an EMPTY filter query specifically, the row
    // renders `promptText` ("> "), the reverse-video cursor (a lone space), and the placeholder as
    // three siblings — `promptText`'s own trailing space used to be dropped ("> Type to filter…",
    // one space) rather than kept ("> " + cursor + placeholder, two spaces) once the row ran out of
    // width, reproducing the exact symptom the ORIGINAL Ink-era Yoga flexShrink arbitration bug had
    // (`components/ModelPicker.tsx`'s own comment explains the fix: `flexShrink={0}` on `promptText`
    // and the cursor).
    test("keeps the cursor's own column visible at a narrow width with an empty filter", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "model-picker-requested", entries: [row()] });
      await flush(setup);

      await resize(setup, 42, DEFAULT_HEIGHT);

      expect(setup.captureCharFrame()).toContain(">  Type to filter");
    });

    // The concrete mechanical proof of "context preserved" (feature-plan.md's own acceptance
    // criterion): onModelSelected only ever carries the picked model/provider — `messages` (and
    // everything else about the session) is never part of the pick at all, so there is nothing to
    // migrate or drop; the reducer's own model-picker-resolved merges it onto whatever session is
    // current when the pick resolves (reducer.test.ts covers that merge directly).
    test("typing filters the list, and Enter resolves the highlighted entry", async () => {
      const selected: Array<{ model: string; provider: ModelProvider; keyConfigured: boolean }> =
        [];
      const startingSession = session({ messages: [{ role: "user", content: "hi" }] });
      const { setup, dispatch } = await connect({
        session: startingSession,
        onModelSelected: (pick) => selected.push(pick),
      });

      dispatch({
        type: "model-picker-requested",
        entries: [
          row({ id: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B" }),
          row({ id: "llama-3.1-8b-instant", displayName: "Llama 3.1 8B" }),
        ],
      });
      await flush(setup);

      // Narrows to the second entry only — "8b" is not a substring of the first entry's id or
      // displayName.
      await setup.mockInput.typeText("8b");
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("8b");

      setup.mockInput.pressEnter();
      await flush(setup);

      expect(selected).toEqual([
        { model: "llama-3.1-8b-instant", provider: "groq", keyConfigured: true },
      ]);
    });

    test("Escape and Ctrl-D both cancel without resolving a model", async () => {
      const cancelled: string[] = [];
      const { setup, dispatch } = await connect({
        onModelPickerCancel: () => cancelled.push("cancelled"),
      });

      dispatch({ type: "model-picker-requested", entries: [row()] });
      await flush(setup);
      setup.mockInput.pressEscape();
      // A bare Escape byte is ambiguous with the start of a longer ANSI sequence (an arrow key,
      // say), so OpenTUI's own parser holds it for a short disambiguation window before treating it
      // as a standalone Escape keypress — longer than the plain macrotask tick `flush()` waits.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flush(setup);
      expect(cancelled).toEqual(["cancelled"]);

      dispatch({ type: "model-picker-requested", entries: [row()] });
      await flush(setup);
      setup.mockInput.pressKey("d", { ctrl: true });
      await flush(setup);
      expect(cancelled).toEqual(["cancelled", "cancelled"]);
    });

    test("shows a +N more hint once the filtered list exceeds the visible window", async () => {
      const { setup, dispatch } = await connect();
      const entries = Array.from({ length: 12 }, (_, i) =>
        row({ id: `model-${i}`, displayName: `Model ${i}` }),
      );

      dispatch({ type: "model-picker-requested", entries });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("+2 more — keep typing to narrow");
    });

    // Regression guard: `remaining` used to be `filtered.length - visible.length`, which counts
    // entries hidden ABOVE the window too and stays flat at `filtered.length - windowSize` for as
    // long as the window is full — the hint never counted down while scrolling toward the bottom,
    // and never disappeared even once every remaining entry was on screen.
    test("the +N more hint count decreases while scrolling down, disappearing at the bottom", async () => {
      const { setup, dispatch } = await connect();
      const entries = Array.from({ length: 12 }, (_, i) =>
        row({ id: `model-${i}`, displayName: `Model ${i}` }),
      );

      dispatch({ type: "model-picker-requested", entries });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("+2 more — keep typing to narrow");

      for (let i = 0; i < 11; i++) {
        setup.mockInput.pressArrow("down");
        await flush(setup);
      }

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Model 11");
      expect(frame).not.toContain("more — keep typing to narrow");
    });

    // C1: the real bug — the visible window used to always be the first LIST_WINDOW_MAX
    // entries regardless of `selectedIndex`, so Down past the 10th entry moved the highlight
    // somewhere nothing on screen showed. Down 15 times over 20 entries lands well past the
    // original window; this checks BOTH halves: the list actually scrolls (the 16th entry, id
    // "model-15", becomes visible; the 1st, "model-0", scrolls out), AND the row Enter resolves is
    // the one actually highlighted.
    //
    // Also a regression guard on the transcript's own wrapping box (app.tsx's own header comment on
    // `flexBasis={0}`/`overflow="hidden"`): with neither of those, this box's own share of the
    // column stayed hostage to the transcript scrollbox's stale, previously-measured height instead
    // of shrinking for a same-frame sibling like ModelPicker, so ANY panel mounted alongside the
    // transcript rendered with stray characters from the transcript's own last render bleeding into
    // its rows — this scenario included, even though it never touches the transcript itself.
    test("Down past the visible window scrolls the list, and Enter selects the highlighted row", async () => {
      const selected: Array<{ model: string; provider: ModelProvider; keyConfigured: boolean }> =
        [];
      const { setup, dispatch } = await connect({
        onModelSelected: (pick) => selected.push(pick),
      });

      const entries = Array.from({ length: 20 }, (_, i) =>
        row({ id: `model-${i}`, displayName: `Model ${i}` }),
      );
      dispatch({ type: "model-picker-requested", entries });
      await flush(setup);

      for (let i = 0; i < 15; i++) {
        setup.mockInput.pressArrow("down");
        await flush(setup);
      }

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Model 15");
      expect(frame).not.toContain("Model 0 ");
      // Pins the ListRow marker: formatModelRow leads with the display name, so it sits right
      // after "> ".
      expect(frame).toContain("> Model 15");

      setup.mockInput.pressEnter();
      await flush(setup);

      expect(selected).toEqual([{ model: "model-15", provider: "groq", keyConfigured: true }]);
    });
  });

  // EffortPanel's own live arrow-key slider, mirroring the "model picker"
  // describe block above — render-on-request, Enter selects, Escape/Ctrl-D cancels.
  describe("effort panel", () => {
    test("renders in place of the input box once requested", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "effort-requested", tiers: ["low", "medium", "high"], selected: 0 });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("> low");
      expect(frame).toContain("medium");
      expect(frame).toContain("high");
    });

    test("Enter resolves the highlighted tier via onEffortSelected", async () => {
      const selected: string[] = [];
      const { setup, dispatch } = await connect({
        onEffortSelected: (tier) => selected.push(tier),
      });

      dispatch({ type: "effort-requested", tiers: ["low", "medium", "high"], selected: 0 });
      await flush(setup);
      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);

      expect(selected).toEqual(["medium"]);
    });

    test("Escape and Ctrl-D both cancel without resolving a tier", async () => {
      const cancelled: string[] = [];
      const { setup, dispatch } = await connect({
        onEffortCancel: () => cancelled.push("cancelled"),
      });

      dispatch({ type: "effort-requested", tiers: ["low", "medium", "high"], selected: 0 });
      await flush(setup);
      setup.mockInput.pressEscape();
      // A bare Escape byte is ambiguous with the start of a longer ANSI sequence (an arrow key,
      // say), so OpenTUI's own parser holds it for a short disambiguation window before treating it
      // as a standalone Escape keypress — longer than the plain macrotask tick `flush()` waits
      // (ModelPicker's own identical Escape test, above, needs the same wait for the same reason).
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flush(setup);
      expect(cancelled).toEqual(["cancelled"]);

      dispatch({ type: "effort-requested", tiers: ["low", "medium", "high"], selected: 0 });
      await flush(setup);
      setup.mockInput.pressKey("d", { ctrl: true });
      await flush(setup);
      expect(cancelled).toEqual(["cancelled", "cancelled"]);
    });

    test("opens with the current tier already highlighted, not always the first", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "effort-requested", tiers: ["low", "medium", "high"], selected: 2 });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("> high");
    });
  });

  describe("setup panel", () => {
    function setupRows(): SetupProviderRow[] {
      return [
        {
          provider: "groq",
          keyName: "GROQ_API_KEY",
          source: "unset",
          masked: undefined,
          removable: false,
        },
        {
          provider: "openrouter",
          keyName: "OPENROUTER_API_KEY",
          source: "config",
          masked: "sk-o...abcd",
          removable: true,
        },
        {
          provider: "anthropic",
          keyName: "ANTHROPIC_API_KEY",
          source: "env",
          masked: "sk-a...wxyz",
          removable: false,
        },
        {
          provider: "openai",
          keyName: "OPENAI_API_KEY",
          source: "unset",
          masked: undefined,
          removable: false,
        },
        {
          provider: "google",
          keyName: "GOOGLE_GENERATIVE_AI_API_KEY",
          source: "unset",
          masked: undefined,
          removable: false,
        },
      ];
    }

    // Code-review finding (PR #73, round 3, item #5): an env row is not always the non-removable
    // case — `formatSetupRow` used to render the same "unset it in your shell" text for EVERY
    // env-sourced row regardless of `removable`, telling a user with a real, removable config.json
    // entry underneath that removal was impossible when it was not.
    describe("formatSetupRow", () => {
      function row(overrides: Partial<SetupProviderRow> = {}): SetupProviderRow {
        return {
          provider: "anthropic",
          keyName: "ANTHROPIC_API_KEY",
          source: "unset",
          masked: undefined,
          removable: false,
          ...overrides,
        };
      }

      test("unset: just the provider name and 'not set'", () => {
        expect(formatSetupRow(row())).toContain("not set");
      });

      test("config: the masked value, labeled (config)", () => {
        const text = formatSetupRow(row({ source: "config", masked: "sk-a...wxyz" }));
        expect(text).toContain("anthropic");
        expect(text).toContain("sk-a...wxyz (config)");
      });

      test("env, not removable: the disabled-remove reason, not a masked value", () => {
        const text = formatSetupRow(
          row({ source: "env", masked: "sk-a...wxyz", removable: false }),
        );
        expect(text).toContain("set by $ANTHROPIC_API_KEY in your environment");
        expect(text).toContain("unset it in your shell");
        expect(text).not.toContain("sk-a...wxyz");
      });

      // The fix itself: env AND removable must say removal is possible, not the disabled reason.
      test("env, removable: says a config.json entry underneath is removable, not that removal is disabled", () => {
        const text = formatSetupRow(row({ source: "env", masked: "sk-a...wxyz", removable: true }));
        expect(text).not.toContain("unset it in your shell");
        expect(text).toContain("removable");
        expect(text).toContain("sk-a...wxyz");
      });
    });

    test("the list step shows all five provider rows, masked values included", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("groq");
      expect(frame).toContain("openrouter");
      expect(frame).toContain("anthropic");
      expect(frame).toContain("openai");
      expect(frame).toContain("google");
      expect(frame).toContain("sk-o...abcd");
      // The env row shows D8's own disabled-remove reason, not a masked value.
      expect(frame).toContain("set by $ANTHROPIC_API_KEY in your environment");
      // Pins the ListRow marker itself, in front of the first (selected) row's own label.
      expect(frame).toContain(`> ${formatSetupRow(setupRows()[0] as SetupProviderRow)}`);
    });

    // `"\r"`, not `"a"`, is the whole point of this test, per the panel's own hint text
    // ("Enter/a add or replace") promising both work.
    test("the list step: Enter (not the 'a' shortcut) selects the highlighted row via onSetupSelect", async () => {
      const selected: ModelProvider[] = [];
      const { setup, dispatch } = await connect({
        onSetupSelect: (provider) => selected.push(provider),
      });

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush(setup);

      // One Down reaches openrouter (index 1) — CATALOG_PROVIDERS order matches setupRows() above.
      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);

      expect(selected).toEqual(["openrouter"]);
    });

    // Same bug, the Delete branch: OpenTUI's Delete key (`\x1b[3~`) is a DIFFERENT sequence from
    // backspace's — distinct enough that fixing Enter alone would not have proven this branch too.
    test("the list step: Delete (not the 'r' shortcut) requests removal via onSetupRemove, when the row is removable", async () => {
      const removeRequested: ModelProvider[] = [];
      const { setup, dispatch } = await connect({
        onSetupRemove: (provider) => removeRequested.push(provider),
      });

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush(setup);

      // openrouter (index 1) is the removable row in setupRows() above.
      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressKey(DELETE_KEY);
      await flush(setup);

      expect(removeRequested).toEqual(["openrouter"]);
    });

    // The negative control this pair rests on: a non-removable row's Delete must still be a no-op,
    // the same guard the 'r' shortcut already had — proving the fix didn't drop that check while
    // moving the branch earlier.
    test("the list step: Delete on a non-removable row calls neither onSetupSelect nor onSetupRemove", async () => {
      const selected: ModelProvider[] = [];
      const removeRequested: ModelProvider[] = [];
      const { setup, dispatch } = await connect({
        onSetupSelect: (provider) => selected.push(provider),
        onSetupRemove: (provider) => removeRequested.push(provider),
      });

      // groq (index 0, the default selection) is source: "unset", removable: false.
      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush(setup);

      setup.mockInput.pressKey(DELETE_KEY);
      await flush(setup);

      expect(selected).toEqual([]);
      expect(removeRequested).toEqual([]);
    });

    // The key-leak guard, and its negative control: `.claude/rules/code-quality.md` requires this
    // assertion to have been SEEN to fail. Verified by temporarily changing SetupEnterKey's own
    // render from `"*".repeat(value.length)` back to the raw `value` and re-running this exact
    // test: it failed, printing the typed string `sk-distinctive-secret-12345` in the captured
    // frame, confirming the assertion actually exercises the masking rather than trivially passing
    // because the string never appeared anywhere for an unrelated reason. Reverted immediately
    // after — the fix below is what's committed.
    test("a typed key is masked in the frame, never rendered raw", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush(setup);
      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider: "groq",
          keyName: "GROQ_API_KEY",
          busy: false,
        },
      });
      await flush(setup);

      const secret = "sk-distinctive-secret-12345";
      await setup.mockInput.typeText(secret);
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).not.toContain(secret);
      expect(frame).toContain("*".repeat(secret.length));
    });

    test("Enter on the enter-key step submits the typed value via onSetupKeyEntered", async () => {
      const entered: Array<{ provider: ModelProvider; value: string }> = [];
      const { setup, dispatch } = await connect({
        onSetupKeyEntered: (provider, value) => entered.push({ provider, value }),
      });

      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider: "openai",
          keyName: "OPENAI_API_KEY",
          busy: false,
        },
      });
      await flush(setup);

      await setup.mockInput.typeText("sk-my-key");
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);

      expect(entered).toEqual([{ provider: "openai", value: "sk-my-key" }]);
    });

    test("while busy, the panel renders Validating… and ignores input", async () => {
      const entered: Array<{ provider: ModelProvider; value: string }> = [];
      const { setup, dispatch } = await connect({
        onSetupKeyEntered: (provider, value) => entered.push({ provider, value }),
      });

      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider: "openai",
          keyName: "OPENAI_API_KEY",
          busy: true,
        },
      });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("Validating…");

      setup.mockInput.pressEnter();
      await flush(setup);

      expect(entered).toEqual([]);
    });

    test("an enter-key error renders with the error mark", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider: "openai",
          keyName: "OPENAI_API_KEY",
          busy: false,
          error: "Invalid API key",
        },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("✕ ");
      expect(frame).toContain("Invalid API key");
    });

    test("confirm-remove: 'y' confirms via onSetupRemove, anything else cancels back via onSetupBack", async () => {
      const removed: ModelProvider[] = [];
      const backCalls: number[] = [];
      const { setup, dispatch } = await connect({
        onSetupRemove: (provider) => removed.push(provider),
        onSetupBack: () => backCalls.push(backCalls.length),
      });

      dispatch({
        type: "setup-step",
        state: {
          step: "confirm-remove",
          provider: "openrouter",
          keyName: "OPENROUTER_API_KEY",
        },
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("! Remove OPENROUTER_API_KEY");
      setup.mockInput.pressKey("n");
      await flush(setup);

      expect(removed).toEqual([]);
      expect(backCalls).toEqual([0]);

      dispatch({
        type: "setup-step",
        state: {
          step: "confirm-remove",
          provider: "openrouter",
          keyName: "OPENROUTER_API_KEY",
        },
      });
      await flush(setup);
      setup.mockInput.pressKey("y");
      await flush(setup);

      expect(removed).toEqual(["openrouter"]);
    });

    // ConfirmPrompt's own guards (ui/ConfirmPrompt.tsx): `key.ctrl || key.meta` and
    // `key.name.length !== 1` ahead of the "y" check are what makes a navigation key a no-op here
    // rather than falling through to the unrecognised-cancels branch and silently backing out of a
    // destructive prompt — the same class of bug ApprovalBox's own arrow/backspace test above
    // exists for.
    test("confirm-remove: an arrow key is a no-op, not an implicit cancel", async () => {
      const removed: ModelProvider[] = [];
      const backCalls: number[] = [];
      const { setup, dispatch } = await connect({
        onSetupRemove: (provider) => removed.push(provider),
        onSetupBack: () => backCalls.push(backCalls.length),
      });

      dispatch({
        type: "setup-step",
        state: {
          step: "confirm-remove",
          provider: "openrouter",
          keyName: "OPENROUTER_API_KEY",
        },
      });
      await flush(setup);

      setup.mockInput.pressArrow("up");
      await flush(setup);
      expect(removed).toEqual([]);
      expect(backCalls).toEqual([]);

      // Still live, not silently cancelled: an actual "y" still confirms.
      setup.mockInput.pressKey("y");
      await flush(setup);
      expect(removed).toEqual(["openrouter"]);
    });

    // Render precedence (app.tsx's own render ternary): pendingApproval beats pendingModelPicker
    // beats pendingSetup beats InputBox.
    test("pendingApproval takes precedence over pendingSetup, which takes precedence over InputBox", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("/setup — provider API keys");

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Approve write_file");
      expect(frame).not.toContain("/setup — provider API keys");
    });
  });

  describe("formatModelRow / formatContextWindow / formatCost", () => {
    function entry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
      return {
        id: "llama-3.3-70b-versatile",
        provider: "groq",
        displayName: "Llama 3.3 70B",
        family: "llama",
        contextWindow: 131_072,
        maxOutputTokens: 32_768,
        toolCall: true,
        reasoning: false,
        pricing: { inputPerMTok: 0.59, outputPerMTok: 0.79 },
        ...overrides,
      };
    }

    function pickerRow(overrides: Partial<ModelPickerEntry> = {}): ModelPickerEntry {
      return {
        entry: entry(),
        keyConfigured: true,
        alternatives: 0,
        gatewayReachable: false,
        ...overrides,
      };
    }

    test("formatContextWindow compacts to binary K/M, matching how a context window is described elsewhere in this repo", () => {
      expect(formatContextWindow(131_072)).toBe("128K");
      expect(formatContextWindow(1_050_000)).toBe("1.0M");
      expect(formatContextWindow(512)).toBe("512");
    });

    test("formatCost formats pricing as $in/$out per 1M, or an em dash when there is none", () => {
      expect(formatCost({ inputPerMTok: 0.59, outputPerMTok: 0.79 })).toBe("$0.59/$0.79");
      expect(formatCost(undefined)).toBe("—");
    });

    test("formatModelRow includes name, provider, context and cost, in that order", () => {
      const row = formatModelRow(pickerRow());
      const nameIndex = row.indexOf("Llama 3.3 70B");
      const providerIndex = row.indexOf("groq");
      const contextIndex = row.indexOf("128K");
      const costIndex = row.indexOf("$0.59/$0.79");
      expect(nameIndex).toBeGreaterThanOrEqual(0);
      expect(providerIndex).toBeGreaterThan(nameIndex);
      expect(contextIndex).toBeGreaterThan(providerIndex);
      expect(costIndex).toBeGreaterThan(contextIndex);
    });

    // D1/D2 (feature-plan.md): the trailing Route column.
    test("formatModelRow renders 'your key' or 'no key', and a '+N route(s)' suffix only when alternatives > 0", () => {
      const configured = formatModelRow(pickerRow({ keyConfigured: true, alternatives: 0 }));
      expect(configured).toContain("your key");
      expect(configured).not.toContain("no key");
      expect(configured).not.toContain("route");

      const unconfigured = formatModelRow(
        pickerRow({ keyConfigured: false, alternatives: 0, rerouteTo: undefined }),
      );
      expect(unconfigured).toContain("no key");
      expect(unconfigured).not.toContain("your key");

      const withOneAlternative = formatModelRow(pickerRow({ alternatives: 1 }));
      expect(withOneAlternative).toContain("+1 route");
      expect(withOneAlternative).not.toContain("+1 routes");

      const withTwoAlternatives = formatModelRow(pickerRow({ alternatives: 2 }));
      expect(withTwoAlternatives).toContain("+2 routes");
    });

    // Same D1/D2 section: a keyless row with a reachable sibling names that sibling directly
    // instead of a bare "no key" plus a count the user would have to guess the meaning of.
    test("formatModelRow names the reroute target on a keyless row that has one", () => {
      const rerouted = formatModelRow(
        pickerRow({ keyConfigured: false, alternatives: 1, rerouteTo: "anthropic" }),
      );
      expect(rerouted).toContain("→ anthropic");
      expect(rerouted).not.toContain("no key");
      // The reroute target already says where this row goes — no need to also restate the raw
      // sibling count next to it.
      expect(rerouted).not.toContain("route");
    });

    // The bug this format replaces: "no key +N routes" used to be shown even when NONE of those
    // N siblings had a key either, promising a fallback that did not exist. A keyless row with no
    // configured sibling must read as a plain dead end, not "no key" plus a misleading count.
    test("formatModelRow shows a bare 'no key' when no sibling has a key either, even with alternatives > 0", () => {
      const deadEnd = formatModelRow(
        pickerRow({ keyConfigured: false, alternatives: 2, rerouteTo: undefined }),
      );
      expect(deadEnd).toContain("no key");
      expect(deadEnd).not.toContain("route");
    });

    test("formatModelRow truncates a displayName longer than the name column", () => {
      const row = formatModelRow(pickerRow({ entry: entry({ displayName: "A".repeat(40) }) }));
      expect(row).toContain("…");
      expect(row.indexOf("A".repeat(40))).toBe(-1);
    });

    // A $0 model whose id/displayName never says "free" (the OpenRouter free-tier naming
    // convention this mirrors, e.g. "stealth/ox-alpha") is still discoverable by typing "free"
    // because matchesFilter also checks pricing, not just the name.
    test("matchesFilter matches a zero-price entry with no 'free' in its name against query 'free'", () => {
      const zeroPrice = pickerRow({
        entry: entry({
          id: "stealth/ox-alpha",
          displayName: "Ox Alpha",
          pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        }),
      });
      expect(matchesFilter(zeroPrice, "free")).toBe(true);
    });

    test("matchesFilter does not match a paid entry against query 'free'", () => {
      const paid = pickerRow({
        entry: entry({ pricing: { inputPerMTok: 0.59, outputPerMTok: 0.79 } }),
      });
      expect(matchesFilter(paid, "free")).toBe(false);
    });

    test("matchesFilter matches a paid entry and not a zero-price entry against query 'paid'", () => {
      const paid = pickerRow({
        entry: entry({ pricing: { inputPerMTok: 0.59, outputPerMTok: 0.79 } }),
      });
      const zeroPrice = pickerRow({
        entry: entry({ pricing: { inputPerMTok: 0, outputPerMTok: 0 } }),
      });
      expect(matchesFilter(paid, "paid")).toBe(true);
      expect(matchesFilter(zeroPrice, "paid")).toBe(false);
    });

    test("matchesFilter matches neither 'free' nor 'paid' for an entry with unknown pricing", () => {
      const unknownPrice = pickerRow({ entry: entry({ pricing: undefined }) });
      expect(matchesFilter(unknownPrice, "paid")).toBe(false);
      expect(matchesFilter(unknownPrice, "free")).toBe(false);
    });

    test("matchesFilter still matches a model whose displayName literally contains 'free', regardless of price", () => {
      const namedFree = pickerRow({
        entry: entry({
          displayName: "FreeChat 1",
          pricing: { inputPerMTok: 0.59, outputPerMTok: 0.79 },
        }),
      });
      expect(matchesFilter(namedFree, "free")).toBe(true);
    });

    test("matchesFilter composes 'free' with other terms across the AND-of-ORs", () => {
      const zeroPriceGroq = pickerRow({
        entry: entry({ provider: "groq", pricing: { inputPerMTok: 0, outputPerMTok: 0 } }),
      });
      const zeroPriceOpenrouter = pickerRow({
        entry: entry({ provider: "openrouter", pricing: { inputPerMTok: 0, outputPerMTok: 0 } }),
      });
      expect(matchesFilter(zeroPriceGroq, "free groq")).toBe(true);
      expect(matchesFilter(zeroPriceOpenrouter, "free groq")).toBe(false);
    });
  });

  // D1 (byok-open3-route-indicator feature-plan.md): formatModelRow's own tests above exercise
  // this indirectly through the picker's Route column; these test the vocabulary function itself,
  // all 4 branches, so the persistent indicator below (which calls it directly, not through a
  // ModelPickerEntry) has its own direct coverage too.
  describe("formatRouteLabel", () => {
    test("keyConfigured wins outright: 'your key'", () => {
      expect(formatRouteLabel({ keyConfigured: true, rerouteTo: "openrouter" })).toBe("your key");
    });

    test("a keyless row with a reroute target: '→ <provider>'", () => {
      expect(formatRouteLabel({ keyConfigured: false, rerouteTo: "openrouter" })).toBe(
        "→ openrouter",
      );
    });

    // D7: unreachable in production today (decideModelPickerOpen's own `planCoverage` default is
    // always-false) — exercised here only as a direct unit test of the vocabulary function itself.
    test("a keyless, no-reroute row with gatewayReachable: 'provided'", () => {
      expect(formatRouteLabel({ keyConfigured: false, gatewayReachable: true })).toBe("provided");
    });

    test("the true dead end — no key, no reroute, no gateway: 'no key'", () => {
      expect(formatRouteLabel({ keyConfigured: false, gatewayReachable: false })).toBe("no key");
    });
  });

  describe("slideWindow", () => {
    // The exact "clamp, don't re-center" cases ModelPicker's own moveSelection relies on.
    test("selection still inside the window: offset does not move", () => {
      expect(slideWindow(0, 5, 10)).toBe(0);
    });

    test("selection above the window: offset jumps up to the selection", () => {
      expect(slideWindow(5, 2, 10)).toBe(2);
    });

    test("selection past the bottom of the window: offset slides just far enough to include it", () => {
      expect(slideWindow(0, 10, 10)).toBe(1);
    });
  });

  describe("singleLine", () => {
    test("collapses \\r\\n, \\r, and \\n into a single space each", () => {
      expect(singleLine("a\r\nb\rc\nd")).toBe("a b c d");
    });

    // Regression: an unsanitized config value (`seri config set` on the CLI does not strip
    // control bytes the way the TUI's own interactive entry does) reaching a row's render could
    // otherwise carry a raw ESC and write an arbitrary escape sequence to the real terminal
    // underneath the alt screen. Escaped to a visible `\xNN` form, not stripped, matching
    // escapeControlChars' own contract (cli/output.ts).
    test("escapes a raw ESC byte instead of passing it through to the real terminal", () => {
      expect(singleLine("before\x1b[31mafter")).toBe("before\\x1b[31mafter");
    });
  });

  describe("listWindowSize", () => {
    // listWindowSize is a pure function of `rows`, tested here at hand-picked inputs.
    test("a tall terminal clamps to LIST_WINDOW_MAX (10)", () => {
      expect(listWindowSize(24)).toBe(10);
    });

    test("a short terminal clamps to MIN_LIST_WINDOW (3), never fewer", () => {
      expect(listWindowSize(5)).toBe(3);
    });

    test("a terminal in between returns rows minus the panel chrome budget", () => {
      expect(listWindowSize(18)).toBe(9);
      expect(listWindowSize(15)).toBe(6);
    });
  });

  describe("persistent mode+route indicator (mounted)", () => {
    // useTerminalDimensions' own live-resize wiring — formatModeDetail's own unit tests
    // (format.test.ts) already cover the tier DECISION logic as a pure function, so this is the
    // one mounted-level smoke test needed to confirm a real resize actually reaches the rendered
    // row end-to-end.
    test("renders the model+route label at the default width, and drops it after a resize below MODE_MODEL_MIN_COLS", async () => {
      const { setup } = await connect();
      expect(setup.captureCharFrame()).toContain("your key");

      await resize(setup, 40, DEFAULT_HEIGHT);

      expect(setup.captureCharFrame()).not.toContain("claude-sonnet-5");
    });

    // runGuidedSetup's own mount shape (cli.ts): no PreparedRun exists yet, so route is undefined.
    test("mounts with route undefined and shows no fabricated route text", async () => {
      const { setup } = await connect({ route: undefined });
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("your key");
      expect(frame).not.toContain("→");
    });

    // Regression test for issue #132: the status bar used to read the `route` PROP, frozen at
    // mount, so a live /model switch (cli.ts's runTurn re-resolving a fresh route every turn)
    // never reached it — only a session quit/remount picked up the new model. `route-updated` is
    // the reducer action that closes this: dispatching it must move the rendered label without
    // remounting <App>.
    test("status bar reflects a route-updated dispatch without remounting", async () => {
      const { setup, dispatch } = await connect();
      expect(setup.captureCharFrame()).toContain("claude-sonnet-5");

      dispatch({
        type: "route-updated",
        route: route({ model: "gpt-4o", provider: "openai" }),
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("gpt-4o");
      expect(frame).not.toContain("claude-sonnet-5");
    });

    // Follow-up to the regression above: a `/model` pick dispatches `model-picker-resolved`,
    // which only ever merged into `state.session` — the status bar (reading `state.route`) stayed
    // on the OLD model until the next turn's `route-updated` dispatch (cli.ts's runTurn). A picked
    // model should be reflected the moment it's picked, not one turn later.
    test("status bar updates immediately from a /model pick, before any turn re-resolves the route", async () => {
      const { setup, dispatch } = await connect();
      expect(setup.captureCharFrame()).toContain("claude-sonnet-5");

      dispatch({
        type: "model-picker-resolved",
        pick: { model: "gpt-4o", provider: "openai", keyConfigured: true },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("gpt-4o");
      expect(frame).not.toContain("claude-sonnet-5");
    });

    // Picking a provider with no configured key means the picker itself doesn't know where
    // resolveRoute will actually route it (a sibling reroute or the gateway) — only the NEXT
    // turn's route-updated dispatch does. Optimistically claiming `rerouted: false` here would
    // render "your key" for a provider the user doesn't have a key for: a fabricated route,
    // exactly what formatModeDetail's own comment says to avoid. The bar should stay on the OLD
    // route rather than assert a wrong one.
    test("a /model pick with no configured key leaves the status bar on the old route, not a fabricated one", async () => {
      const { setup, dispatch } = await connect();
      expect(setup.captureCharFrame()).toContain("claude-sonnet-5");
      expect(setup.captureCharFrame()).toContain("your key");

      dispatch({
        type: "model-picker-resolved",
        pick: { model: "some-unconfigured-model", provider: "openrouter", keyConfigured: false },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("claude-sonnet-5");
      expect(frame).not.toContain("some-unconfigured-model");
    });

    // Locates the mode row specifically rather than searching the whole frame — a whole-frame
    // `toContain("high")` could pick up unrelated transcript text, reporting success identically
    // to a broken indicator.
    function modeRow(setup: TestRendererSetup): string | undefined {
      return setup
        .captureCharFrame()
        .split("\n")
        .find((l) => l.includes(MODE_LABEL["approve-each"]));
    }

    test("an effort-resolved dispatch renders the tier in the mode row, in the same render pass", async () => {
      const { setup, dispatch } = await connect({
        catalog: catalogOf([
          catalogEntry({
            reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
          }),
        ]),
      });

      dispatch({ type: "effort-resolved", tier: "high" });
      await flush(setup);

      expect(modeRow(setup)).toContain("claude-sonnet-5 · your key · high");
    });

    test("/effort auto (a session-updated dispatch clearing reasoningEffort) removes the tier from the mode row", async () => {
      const { setup, dispatch } = await connect({
        catalog: catalogOf([
          catalogEntry({
            reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
          }),
        ]),
      });
      dispatch({ type: "effort-resolved", tier: "high" });
      await flush(setup);
      expect(modeRow(setup)).toContain("· high");

      dispatch({ type: "session-updated", session: session({ reasoningEffort: undefined }) });
      await flush(setup);

      expect(modeRow(setup)).not.toContain("· high");
      expect(modeRow(setup)).toContain("claude-sonnet-5 · your key");
    });

    // A tier surviving a model switch onto a model with no reasoningOptions at all (the reducer
    // does not gate `effort-resolved` on legality) must not render — appliedReasoningEffort's own
    // legality check is what makes this the case, not anything special in the row itself. Covers
    // both sources appliedReasoningEffort is fed (session override and config default): neither
    // bypasses the legality check.
    test("a stale tier on a model with no reasoningOptions does not render, from either source", async () => {
      const { setup, dispatch } = await connect({
        catalog: catalogOf([catalogEntry({ reasoningOptions: undefined })]),
      });

      dispatch({ type: "effort-resolved", tier: "high" });
      await flush(setup);

      expect(modeRow(setup)).not.toContain("· high");
      expect(modeRow(setup)).toContain("claude-sonnet-5 · your key");

      dispatch({ type: "session-updated", session: session({ reasoningEffort: undefined }) });
      await flush(setup);
      dispatch({ type: "config-updated", config: { SERI_REASONING_EFFORT: "high" } });
      await flush(setup);

      expect(modeRow(setup)).not.toContain("· high");
      expect(modeRow(setup)).toContain("claude-sonnet-5 · your key");
    });

    // Fresh session (no `effort-resolved` ever dispatched) with a config default present: the
    // header must reflect it, since driveLoop already resolves at this tier from turn 1
    // (resolveReasoningEffort, provider/reasoning.ts) — the bug this test suite guards against.
    test("a config-updated dispatch, with no session override, renders the tier in the mode row", async () => {
      const { setup, dispatch } = await connect({
        catalog: catalogOf([
          catalogEntry({
            reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
          }),
        ]),
      });

      dispatch({ type: "config-updated", config: { SERI_REASONING_EFFORT: "high" } });
      await flush(setup);

      expect(modeRow(setup)).toContain("claude-sonnet-5 · your key · high");
    });

    // The mount-time counterpart of the dispatch-based test above, and the actual regression guard
    // for the bug it left uncovered: App's OWN `useReducer(tuiReducer, initialTuiState(session, {
    // route, config }))` call (app.tsx) must seed `state.config` from the `config` PROP at mount,
    // not only ever receive it via a later `config-updated` dispatch — every other case in this
    // describe block dispatches that action first, so none of them can tell a real mount-time seed
    // apart from a reducer that starts `{}` and only happens to be fixed up before the first
    // assertion. Zero dispatches here: the tier must already be in the very first rendered frame.
    test("mounting with a config default already renders the tier, with no dispatch at all", async () => {
      const { setup } = await connect({
        catalog: catalogOf([
          catalogEntry({
            reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
          }),
        ]),
        config: { SERI_REASONING_EFFORT: "high" },
      });

      expect(modeRow(setup)).toContain("claude-sonnet-5 · your key · high");
    });

    // Fresh session, no config default dispatched either: confirms the existing no-tier behavior
    // is unchanged by the new `config` field (it stays `{}` until a `config-updated` dispatch
    // supplies a record with `SERI_REASONING_EFFORT` in it).
    test("no session override and no config default: the mode row shows no tier", async () => {
      const { setup } = await connect({
        catalog: catalogOf([
          catalogEntry({
            reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
          }),
        ]),
      });

      expect(modeRow(setup)).not.toContain("· high");
      expect(modeRow(setup)).toContain("claude-sonnet-5 · your key");
    });

    // A session override (`/effort`) must keep winning outright over a config default present at
    // the same time — `state.session.reasoningEffort ?? loadReasoningEffortConfig(state.config)`
    // (app.tsx) only falls through to the default when the session field is `undefined`.
    test("an effort-resolved override wins over a config-updated dispatch", async () => {
      const { setup, dispatch } = await connect({
        catalog: catalogOf([
          catalogEntry({
            reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
          }),
        ]),
      });

      dispatch({ type: "config-updated", config: { SERI_REASONING_EFFORT: "low" } });
      await flush(setup);
      dispatch({ type: "effort-resolved", tier: "high" });
      await flush(setup);

      expect(modeRow(setup)).toContain("claude-sonnet-5 · your key · high");
      expect(modeRow(setup)).not.toContain("· low");
    });

    // guidedSetup.ts/welcomeSplash.ts's own mounts omit `catalog` entirely — this confirms that is
    // safe, not just untested.
    test("mounting with no catalog prop is safe: no crash, and no tier renders", async () => {
      const { setup, dispatch } = await connect({ catalog: undefined });

      dispatch({ type: "effort-resolved", tier: "high" });
      await flush(setup);

      expect(modeRow(setup)).not.toContain("· high");
      expect(modeRow(setup)).toContain("claude-sonnet-5 · your key");
    });
  });

  describe("mode row color and hint", () => {
    // theme.mode's own entries are a mix of hex ("#8ab4c8") and the ANSI-16 name "gray"
    // (approve-each, = theme.muted) — parseColor, not RGBA.fromHex directly, is what every real
    // `fg` prop resolves through (theme.ts's own header comment), so it's what a fair comparison
    // here has to go through too: RGBA.fromHex("gray") is not a valid hex string and would silently
    // resolve to magenta instead of failing loudly. `.includes`, not `===`: approve-each's own hue
    // is literally the same value as the hint/detail's `theme.muted`, so the renderer merges them
    // into one span with no style boundary between them — the indicator's own text is a substring
    // of that merged span, not the whole span, for that one mode only.
    test("each permission mode renders its indicator with its own theme.mode color", async () => {
      const modes: PermissionMode[] = ["read-only", "approve-each", "auto"];
      for (const mode of modes) {
        const { setup } = await connect({ session: session({ permissionMode: mode }) });
        const label = MODE_LABEL[mode];
        const frame = setup.captureSpans();
        const line = frame.lines.find((l) => l.spans.some((s) => s.text.includes(label)));
        const span = line?.spans.find((s) => s.text.includes(label));
        expect(span?.fg.equals(parseColor(theme.mode[mode]))).toBe(true);
      }
    });

    // The mode hue is confined to the indicator — formatModeDetail's own `detail` (the model name +
    // route) is a SEPARATE `<text fg={theme.muted}>`, so it must never pick up `auto`'s own rust
    // hue even though it sits right next to it.
    test("the model name stays theme.muted, not the mode hue, even in auto", async () => {
      const { setup } = await connect({ session: session({ permissionMode: "auto" }) });
      const frame = setup.captureSpans();
      const line = frame.lines.find((l) => l.spans.some((s) => s.text.includes("claude-sonnet-5")));
      const span = line?.spans.find((s) => s.text.includes("claude-sonnet-5"));
      expect(span?.fg.equals(parseColor(theme.muted))).toBe(true);
      expect(span?.fg.equals(parseColor(theme.mode.auto))).toBe(false);
    });

    test("the shift+tab hint is present at MODE_HINT_COLS and absent below it", async () => {
      const { setup } = await connect();
      expect(setup.captureCharFrame()).toContain("(shift+tab to cycle)");

      await resize(setup, MODE_HINT_COLS, DEFAULT_HEIGHT);
      expect(setup.captureCharFrame()).toContain("(shift+tab to cycle)");

      await resize(setup, MODE_HINT_COLS - 1, DEFAULT_HEIGHT);
      expect(setup.captureCharFrame()).not.toContain("(shift+tab to cycle)");
    });

    // Even with a route present, the row's own arithmetic (indicator + hint + the model-only
    // detail the width ladder allows at this width) must actually fit 80 columns in the RENDERED
    // row, not just in formatModeDetail's own return value.
    test("at 80 columns, the longest label with a route present fits the row and does not wrap", async () => {
      const { setup } = await connect({
        session: session({ permissionMode: "auto" }),
        route: route(),
      });
      await resize(setup, DEFAULT_COLUMNS, DEFAULT_HEIGHT);

      const expectedRow = `${MODE_LABEL.auto}${MODE_CYCLE_HINT}  claude-sonnet-5`;
      const lines = setup.captureCharFrame().split("\n");
      const modeLine = lines.find((l) => l.includes(expectedRow));
      expect(modeLine).toBeDefined();
      expect(modeLine?.trimEnd().length).toBeLessThanOrEqual(DEFAULT_COLUMNS);
    });

    // `⏸`/`⏵⏵` are outside the BMP-only glyph set used elsewhere in this file and could render
    // double-width, corrupting the row's own column math — so their cell width has to be measured,
    // not assumed. `captureSpans()` groups a whole `<text>` node into one span
    // rather than one span per character, so there is no isolated "just the glyph" span to measure
    // directly; instead, the indicator span's OWN measured `width` equalling its `length` (JS
    // UTF-16 code units, ASCII for every character here except the glyph) proves every character in
    // it — the glyph included — rendered as exactly one cell. If the glyph rendered double-width,
    // this span's `width` would exceed its `length` by one.
    test("the pause glyph (⏸) renders single-width in the component renderer", async () => {
      const { setup } = await connect({ session: session({ permissionMode: "read-only" }) });
      const label = MODE_LABEL["read-only"];
      const frame = setup.captureSpans();
      const line = frame.lines.find((l) => l.spans.some((s) => s.text === label));
      const span = line?.spans.find((s) => s.text === label);
      expect(span?.width).toBe(label.length);
    });

    test("the play glyphs (⏵⏵) render single-width each in the component renderer", async () => {
      const { setup } = await connect({ session: session({ permissionMode: "auto" }) });
      const label = MODE_LABEL.auto;
      const frame = setup.captureSpans();
      const line = frame.lines.find((l) => l.spans.some((s) => s.text === label));
      const span = line?.spans.find((s) => s.text === label);
      expect(span?.width).toBe(label.length);
    });

    // Regression (found live via tests/tui/tuiPty.test.ts's real-pty PageUp assertion, which
    // started failing once the label grew a glyph + persistent hint): the mode row and the
    // "↑ scrolled — End to follow" banner share one row via `justifyContent="space-between"`, but
    // formatModeDetail's own width tiers only ever accounted for the row's LEFT-hand content. At 80
    // columns with a route present, the model name showing on the left plus the banner on the
    // right together exceed 80 cells, and OpenTUI wraps the row across two lines — splitting the
    // banner's own text mid-word, so "sawLine" style assertions (and a real user) never see it
    // intact.
    test("the scroll banner and the mode row's model name coexist at 80 columns without wrapping", async () => {
      const { setup, dispatch } = await connect({ route: route() });
      await resize(setup, DEFAULT_COLUMNS, DEFAULT_HEIGHT);

      for (let i = 0; i < 300; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);
      setup.mockInput.pressKey(PAGE_UP);
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("↑ scrolled — End to follow");
      const lines = frame.split("\n");
      const bannerLine = lines.find((l) => l.includes("↑ scrolled — End to follow"));
      expect(bannerLine?.trimEnd().length).toBeLessThanOrEqual(DEFAULT_COLUMNS);
    });

    // Regression: the fix above only reserved the right-side banner's width in the call to
    // formatModeDetail (which gates the model/route detail), not in the hint's own visibility check
    // a few lines below — so at a width narrower than 80 (no room for the model anyway, so the
    // first fix's own test never exercised this), the hint alone could still collide with the
    // banner. 60 columns: "⏸ approve-each mode on" (22) + hint (21) = 43, well under 52
    // (MODE_HINT_COLS against the raw width) even though 43 + the banner's 26 = 69 > 60.
    test("the scroll banner and the hint coexist at a narrow width without wrapping", async () => {
      const { setup, dispatch } = await connect();
      await resize(setup, 60, DEFAULT_HEIGHT);

      for (let i = 0; i < 300; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);
      setup.mockInput.pressKey(PAGE_UP);
      await flush(setup);

      const frame = setup.captureCharFrame();
      const lines = frame.split("\n");
      const bannerLine = lines.find((l) => l.includes("↑ scrolled — End to follow"));
      expect(bannerLine).toBeDefined();
      expect(bannerLine?.trimEnd().length).toBeLessThanOrEqual(60);
    });

    // Regression: unlike the hint/model/route, the mode label itself has no width tier — it never
    // shrinks or hides as the terminal narrows, since there's no shorter fallback for a mode's own
    // name. At 40 columns, `auto`'s label (⏵⏵ bypass permissions on, 24 cols) plus a running-tool
    // `state.status` ("Running write_file…", 20 cols) together exceed the row, and without the
    // right side backing off, OpenTUI wraps the row across two lines — splitting both the label and
    // the status mid-word. A split terminal pane hits this width routinely.
    test("a narrow terminal with a running-tool status does not wrap the mode row", async () => {
      const { setup, dispatch } = await connect({ session: session({ permissionMode: "auto" }) });
      await resize(setup, 40, DEFAULT_HEIGHT);

      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "write_file", args: {} },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      const lines = frame.split("\n");
      const modeLine = lines.find((l) => l.includes("bypass permissions on"));
      expect(modeLine).toBeDefined();
      expect(modeLine?.trimEnd().length).toBeLessThanOrEqual(40);
    });
  });

  describe("shift+tab cycles the permission mode", () => {
    // `onCycleMode` is a bare signal out to the caller (this component's own comment on the prop
    // explains why it never dispatches into its own reducer directly) — the label changing is
    // exercised as a SEPARATE step here, via the same `dispatch` a real cli.ts would eventually
    // call, rather than folded into `onCycleMode` itself.
    test("shift+tab calls onCycleMode once, and the label changes after the resulting session-updated", async () => {
      let calls = 0;
      const { setup, dispatch } = await connect({
        session: session({ permissionMode: "read-only" }),
        onCycleMode: () => calls++,
      });
      expect(setup.captureCharFrame()).toContain("read-only mode on");

      setup.mockInput.pressKey(SHIFT_TAB);
      await flush(setup);
      expect(calls).toBe(1);

      dispatch({ type: "session-updated", session: session({ permissionMode: "auto" }) });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("bypass permissions on");
    });

    // A panel/approval box owns the keyboard while it's open — the same `noPanelOpen` gate the
    // scroll keys above already share.
    test("shift+tab does nothing while a panel is open", async () => {
      let calls = 0;
      const { setup, dispatch } = await connect({ onCycleMode: () => calls++ });

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: false,
      });
      await flush(setup);

      setup.mockInput.pressKey(SHIFT_TAB);
      await flush(setup);

      expect(calls).toBe(0);
    });

    // The skills panel is the newest branch of the render ternary, and a panel added without being
    // added to `noPanelOpen` leaves the global keys live underneath it — shift+tab silently cycling
    // the permission mode while the user is arrowing a list is exactly the kind of thing nobody
    // notices until it has already happened.
    test("shift+tab does nothing while the skills panel is open", async () => {
      let calls = 0;
      const { setup, dispatch } = await connect({ onCycleMode: () => calls++ });

      dispatch({
        type: "skills-requested",
        rows: [
          {
            name: "reviewer",
            description: "Reviews a diff.",
            scope: "project",
            where: ".seri/skills/reviewer/SKILL.md",
            author: "human",
            modelInvocable: true,
          },
        ],
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("Skills");

      setup.mockInput.pressKey(SHIFT_TAB);
      await flush(setup);

      expect(calls).toBe(0);
    });

    // Same guard, `pendingMcp`'s own branch — added alongside pendingSkills in noPanelOpen, same
    // reasoning as the skills test just above.
    test("shift+tab does nothing while the mcp panel is open", async () => {
      let calls = 0;
      const { setup, dispatch } = await connect({ onCycleMode: () => calls++ });

      dispatch({
        type: "mcp-requested",
        rows: [
          { kind: "header", scope: "project", sourceFile: ".seri/mcp/servers.yaml" },
          {
            kind: "server",
            name: "exa",
            scope: "project",
            status: { state: "idle" },
            toolCount: undefined,
          },
        ],
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("MCP servers");

      setup.mockInput.pressKey(SHIFT_TAB);
      await flush(setup);

      expect(calls).toBe(0);
    });

    // Plain Tab (no shift) shares the same `key.name === "tab"`, so this proves the `key.shift`
    // check is what actually gates the cycle, not just the key name. `isPrintableKey`
    // (util/keys.ts) already excludes a `key.name.length > 1` key like "tab" from InputBox's own
    // typed-buffer handling — this also confirms that holds for real, not just by that function's
    // own logic.
    test("plain TAB does not cycle the mode and does not modify the input buffer", async () => {
      let calls = 0;
      const submitted: string[] = [];
      const { setup } = await connect({
        onCycleMode: () => calls++,
        onSubmit: (v) => submitted.push(v),
      });

      await setup.mockInput.typeText("hello");
      setup.mockInput.pressKey("\t");
      await setup.mockInput.typeText(" world");
      setup.mockInput.pressEnter();
      await flush(setup);

      expect(calls).toBe(0);
      expect(submitted).toEqual(["hello world"]);
    });

    // The keypress handler only ever calls `onCycleMode` — nothing about it touches the
    // transcript. A no-op `onCycleMode` here isolates that from whatever a real caller's own
    // `onCycleMode` might separately choose to dispatch.
    test("shift+tab does not append a transcript entry", async () => {
      const { setup, dispatch } = await connect({ onCycleMode: () => {} });
      dispatch({ type: "transcript-append", line: "hello" });
      await flush(setup);
      const before = setup.captureCharFrame();

      setup.mockInput.pressKey(SHIFT_TAB);
      await flush(setup);

      expect(setup.captureCharFrame()).toBe(before);
    });
  });

  describe("skipPermissions pins the indicator to bypass", () => {
    // --dangerously-skip-permissions overrides getPermissionMode() (cli.ts) to "auto" regardless
    // of the session's own stored permissionMode — the indicator must not claim a mode the gate
    // isn't actually enforcing.
    test("the label and hue read bypass permissions on, in theme.mode.auto, regardless of the stored mode", async () => {
      const { setup } = await connect({
        session: session({ permissionMode: "approve-each" }),
        skipPermissions: true,
      });

      const label = MODE_LABEL.auto;
      expect(setup.captureCharFrame()).toContain(label);
      expect(setup.captureCharFrame()).not.toContain("approve-each mode on");

      const frame = setup.captureSpans();
      const line = frame.lines.find((l) => l.spans.some((s) => s.text.includes(label)));
      const span = line?.spans.find((s) => s.text.includes(label));
      expect(span?.fg.equals(parseColor(theme.mode.auto))).toBe(true);
    });

    test("shift+tab does not call onCycleMode while skipPermissions is set", async () => {
      let calls = 0;
      const { setup } = await connect({
        session: session({ permissionMode: "approve-each" }),
        skipPermissions: true,
        onCycleMode: () => calls++,
      });

      setup.mockInput.pressKey(SHIFT_TAB);
      await flush(setup);

      expect(calls).toBe(0);
    });
  });

  // Stage A scaffolding (cli-commands-to-tui feature-plan.md): nothing dispatches
  // auth-requested/config-requested/permissions-requested yet — these tests seed the reducer's
  // state directly (auth-offer/auth-step/config-step/permissions-step) to prove the render wiring
  // itself is correct ahead of Stages C-D's dispatchers.
  describe("auth banner", () => {
    test("show: true renders the offer alongside InputBox, not in place of it", async () => {
      const submitted: string[] = [];
      const { setup, dispatch } = await connect({ onSubmit: (v) => submitted.push(v) });

      dispatch({ type: "auth-offer", show: true });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("/login");
      expect(frame).toContain("/signup");
      // Non-blocking proof: InputBox is still mounted (not replaced) — typing still reaches
      // onSubmit, exactly as it would with the banner absent.
      await setup.mockInput.typeText("still typing");
      setup.mockInput.pressEnter();
      await flush(setup);
      expect(submitted).toEqual(["still typing"]);
    });

    test("show: false renders nothing extra", async () => {
      const { setup, dispatch } = await connect();
      const before = setup.captureCharFrame();

      dispatch({ type: "auth-offer", show: false });
      await flush(setup);

      expect(setup.captureCharFrame()).toBe(before);
    });

    // The banner sits ABOVE the render ternary (app.tsx's own comment) rather than as one
    // of its branches — the zeroKeys x noAuth "both at once" cell, component level: a first run
    // with no provider key opens /setup's own panel, and the banner must still render alongside it
    // rather than being replaced the way ApprovalBox/ModelPicker/SetupPanel replace each other.
    test("renders alongside a pendingSetup panel, not replaced by it", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "setup-requested", rows: [] });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("/login");
      expect(frame).toContain("/setup — provider API keys");
    });

    // Bug fix (thermo-nuclear + code-review, round 4 — the root-cause fix): three earlier rounds
    // all patched a new place that forgot to dispatch `auth-offer: false` the moment a login
    // attempt opened; the actual fix is deriving the banner from `pendingAuth` (app.tsx's own
    // `state.authOffer && state.pendingAuth === undefined`) instead of commanding it. This test
    // dispatches ONLY `auth-requested` — no manual `auth-offer` dispatch at all, unlike the old
    // version of this test — and the banner still hides, because `authOffer` itself is
    // deliberately left `true` here: the derivation is what's doing the work, not a stale flag
    // that happens to already be false.
    test("hides while AuthPanel is showing, purely from pendingAuth being set — authOffer itself stays true", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("/login");

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Starting login");
      expect(frame).not.toContain("Sign in with /login, or create an account with /signup");
    });

    // Bug fix (this same round): the derivation above only covers "hide while the panel is open"
    // — the instant a successful login's own `auth-resolved` clears `pendingAuth` again, the
    // derivation reduces to bare `authOffer`, which was never updated to reflect the session that
    // just got saved. createAuthHandlers.onLogin's own success path (tui/state/handlers.ts)
    // recomputes it fresh right after, exactly like onLogout's `show: true` and the mount/
    // onAuthResolved recomputes already do for their own real state changes — this reproduces that
    // exact three-dispatch sequence and checks the banner does NOT flash back on.
    test("stays hidden after a successful login, not just while the panel is open", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);

      dispatch({ type: "transcript-append", line: "Logged in as a@example.com" });
      dispatch({ type: "auth-resolved" });
      dispatch({ type: "auth-offer", show: false });
      await flush(setup);

      expect(setup.captureCharFrame()).not.toContain(
        "Sign in with /login, or create an account with /signup",
      );
    });
  });

  describe("auth panel", () => {
    test("starting step shows a brief starting message for the given mode", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-requested", mode: "signup" });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("signup");
    });

    test("device step shows the verification URL and user code", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);
      dispatch({
        type: "auth-step",
        state: {
          step: "device",
          mode: "login",
          verificationUri: "https://example.com/device",
          userCode: "ABCD-1234",
        },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("https://example.com/device");
      expect(frame).toContain("ABCD-1234");
    });

    // Color (theme.error) is not asserted: `captureCharFrame()` returns plain characters with no
    // color/attribute info — the same reason no other test in this file asserts on a theme color,
    // only on rendered text.
    test("result step shows the message, for both a success and an error result", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);
      dispatch({
        type: "auth-step",
        state: { step: "result", message: "Signed in as a@example.com", error: false },
      });
      await flush(setup);
      let frame = setup.captureCharFrame();
      expect(frame).toContain("Signed in as a@example.com");
      // Its own negative control: the success result must NOT carry the error mark.
      expect(frame).not.toContain("✕ ");

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);
      dispatch({
        type: "auth-step",
        state: { step: "result", message: "Login failed: expired code", error: true },
      });
      await flush(setup);
      frame = setup.captureCharFrame();
      expect(frame).toContain("Login failed: expired code");
      expect(frame).toContain("✕ ");
    });

    // auth-resolved is the reducer action createAuthHandlers' own onLogin/onLogout
    // (tui/state/handlers.ts) fire once a device-flow result lands — proves the panel's own text
    // (including the result step's message, the closest thing this panel has to hint text) is
    // fully gone afterward, not just that SOME frame changed, and that InputBox is genuinely back
    // (accepts input), not merely that nothing matched the render ternary's earlier branches.
    test("clears the panel entirely, restoring InputBox", async () => {
      const submitted: string[] = [];
      const { setup, dispatch } = await connect({ onSubmit: (v) => submitted.push(v) });

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);
      dispatch({
        type: "auth-step",
        state: { step: "result", message: "Signed in as a@example.com", error: false },
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("Signed in as a@example.com");

      dispatch({ type: "auth-resolved" });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("Signed in as a@example.com");
      await setup.mockInput.typeText("back to typing");
      setup.mockInput.pressEnter();
      await flush(setup);
      expect(submitted).toEqual(["back to typing"]);
    });

    // Without AuthPanel's own useKeyboard, a failed login/signup (createAuthHandlers' own catch,
    // tui/state/handlers.ts — a denied/expired code, a network error) would leave the "result" step
    // up with no keyboard path back at all, not even Ctrl-C. Presses a REAL key (not a direct
    // auth-resolved dispatch, which "clears the panel
    // entirely" above already covers) to prove AuthPanel's own Enter/Esc handling is actually
    // wired through app.tsx's onAuthResolved prop — the same wiring-proof shape ConfigPanel's own
    // "Esc on the list step calls onConfigClose" test uses.
    test("Enter on the result step calls onAuthResolved and returns to InputBox", async () => {
      const resolved: number[] = [];
      const { setup, dispatch } = await connect({
        onAuthResolved: () => resolved.push(resolved.length),
      });

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);
      dispatch({
        type: "auth-step",
        state: { step: "result", message: "Authorization was denied.", error: true },
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("Authorization was denied.");

      setup.mockInput.pressEnter();
      await flush(setup);

      expect(resolved).toEqual([0]);
    });

    // Escape on the result step: AuthPanel's own explicit key.name === "escape" check, not
    // something it gets from ConfirmPrompt — that component never inspects Escape and treats a
    // bare Escape as an inert stray keypress there, not a cancel.
    test("Escape on the result step also calls onAuthResolved", async () => {
      const resolved: number[] = [];
      const { setup, dispatch } = await connect({
        onAuthResolved: () => resolved.push(resolved.length),
      });

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);
      dispatch({
        type: "auth-step",
        state: { step: "result", message: "The login request expired.", error: true },
      });
      await flush(setup);

      setup.mockInput.pressEscape();
      // A bare Escape byte is ambiguous with the start of a longer ANSI sequence — OpenTUI's own
      // parser holds it for a short disambiguation window before treating it as standalone
      // (ConfigPanel's own Escape test below needs the same wait for the same reason).
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flush(setup);

      expect(resolved).toEqual([0]);
    });

    // The real soft-lock this fix closes (thermo-nuclear + code-review, round 4): before this,
    // NOTHING dismissed "starting"/"device" — no keyboard handling on either step, and Ctrl-C
    // routes to onCancel (a hard process kill with no turn in flight to arm the cancel slot), not
    // to clearing pendingAuth. A mistyped /login or a slow WorkOS device flow used to cost the
    // whole TUI session.
    test("Escape on the device step also calls onAuthResolved and returns to InputBox", async () => {
      const resolved: number[] = [];
      const submitted: string[] = [];
      let dispatch: Dispatch | undefined;
      const { setup } = await connect({
        connectDispatch: (d) => (dispatch = d),
        // Unlike the two result-step tests above (which only prove the prop fires), this one
        // also dispatches auth-resolved itself — cli.ts's own onAuthResolved wiring does the
        // same (its own comment) — so the frame assertions below observe the real end-to-end
        // effect, not just that the callback ran.
        onAuthResolved: () => {
          resolved.push(resolved.length);
          dispatch?.({ type: "auth-resolved" });
        },
        onSubmit: (v) => submitted.push(v),
      });
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);
      dispatch({
        type: "auth-step",
        state: {
          step: "device",
          mode: "login",
          verificationUri: "https://example.com/device",
          userCode: "ABCD-1234",
        },
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("ABCD-1234");

      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flush(setup);

      expect(resolved).toEqual([0]);
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("ABCD-1234");
      await setup.mockInput.typeText("back to typing");
      setup.mockInput.pressEnter();
      await flush(setup);
      expect(submitted).toEqual(["back to typing"]);
    });
  });

  describe("config panel", () => {
    function configRows(): ConfigRow[] {
      return [
        {
          key: "SERI_VERIFY_ENABLED",
          masked: "",
          source: "unset",
          removable: false,
          kind: "boolean",
          on: true,
        },
        {
          key: "SERI_SOME_OTHER_KEY",
          masked: "sk-d...2345",
          source: "config",
          removable: true,
          kind: "string",
        },
      ];
    }

    test("the list step shows each row's label and masked value", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "config-requested", rows: configRows() });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Automatic verification: on");
      expect(frame).not.toContain("SERI_VERIFY_ENABLED");
      expect(frame).toContain("SERI_SOME_OTHER_KEY");
      expect(frame).toContain("sk-d...2345");
    });

    test("the selected row's description renders, and moving Down swaps it for the next row's", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "config-requested", rows: configRows() });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain(
        "Run the verify command after each file edit and show failures to the model.",
      );

      setup.mockInput.pressArrow("down");
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).not.toContain(
        "Run the verify command after each file edit and show failures to the model.",
      );
    });

    // Up-arrow is never pressed by any panel test elsewhere in this file (every list-panel test
    // presses Down only) — handleArrowKey's own top clamp (useListWindow.ts, `Math.max(0, next)`
    // on the upArrow branch's `current.selected - 1`) is otherwise entirely uncovered by this
    // suite.
    test("Up moves the selection back, and clamps at the top without wrapping or going negative", async () => {
      const { setup, dispatch } = await connect();

      const rows = Array.from({ length: 3 }, (_, i) => ({
        key: `FAKE_KEY_${i}`,
        masked: "",
        source: "unset" as const,
        removable: false,
        kind: "string" as const,
      }));
      dispatch({ type: "config-requested", rows });
      await flush(setup);

      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressArrow("down");
      await flush(setup);

      setup.mockInput.pressArrow("up");
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("> FAKE_KEY_1");

      setup.mockInput.pressArrow("up");
      await flush(setup);
      setup.mockInput.pressArrow("up"); // already at the top, must not wrap or go negative
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("> FAKE_KEY_0");
    });

    test("the hint reads 'Enter/a toggle' on the boolean row and 'Enter/a set' after moving to a string row", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "config-requested", rows: configRows() });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("Enter/a toggle");

      setup.mockInput.pressArrow("down");
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("Enter/a set");
    });

    test("Enter on the boolean row calls onConfigSelect with its key", async () => {
      const selected: string[] = [];
      const { setup, dispatch } = await connect({
        onConfigSelect: (key) => selected.push(key),
      });

      dispatch({ type: "config-requested", rows: configRows() });
      await flush(setup);

      setup.mockInput.pressEnter();
      await flush(setup);

      expect(selected).toEqual(["SERI_VERIFY_ENABLED"]);
    });

    // The key-leak guard, mirroring SetupEnterKey's own test above: a raw secret-shaped value must
    // never appear in the frame, on the list step (only the already-masked value is shown) or the
    // enter-value step (typed characters render as "*").
    test("a raw secret-shaped value never appears in the frame", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "config-requested",
        rows: [
          {
            key: "SERI_SOME_OTHER_KEY",
            masked: "sk-d...2345",
            source: "config",
            removable: true,
            kind: "string",
          },
        ],
      });
      await flush(setup);

      expect(setup.captureCharFrame()).not.toContain("sk-distinctive-secret-12345");

      dispatch({
        type: "config-step",
        state: { step: "enter-value", key: "SERI_SOME_OTHER_KEY", busy: false },
      });
      await flush(setup);

      const secret = "sk-distinctive-secret-12345";
      await setup.mockInput.typeText(secret);
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).not.toContain(secret);
      expect(frame).toContain("*".repeat(secret.length));
    });

    test("an enter-value error renders with the error mark", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "config-step",
        state: {
          step: "enter-value",
          key: "SERI_SOME_OTHER_KEY",
          busy: false,
          error: "Invalid value",
        },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("✕ ");
      expect(frame).toContain("Invalid value");
    });

    // Review round 3 finding (MEDIUM-1's own test coverage gap): onConfigClose is an optional
    // AppProps handler with nothing that goes red if app.tsx's own render call stopped passing it
    // through to ConfigPanel — this proves the wiring, not just that ConfigList's own Esc handling
    // works (that's this component's own concern, already implicit in it having a prop at all).
    test("Esc on the list step calls onConfigClose", async () => {
      const closed: number[] = [];
      const { setup, dispatch } = await connect({
        onConfigClose: () => closed.push(closed.length),
      });

      dispatch({ type: "config-requested", rows: configRows() });
      await flush(setup);

      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flush(setup);

      expect(closed).toEqual([0]);
    });

    // ConfirmPrompt's own convention (mirroring the setup panel's confirm-remove test above): the
    // [y]es/[N]o prompt renders, and only an explicit "y" confirms via onConfigUnset —
    // Enter and any other unrecognised key both cancel back via onConfigBack.
    test("confirm-unset: '[y]es / [N]o' renders; Enter and an unrecognised key both cancel, 'y' confirms", async () => {
      const unset: string[] = [];
      const backCalls: number[] = [];
      const { setup, dispatch } = await connect({
        onConfigUnset: (key) => unset.push(key),
        onConfigBack: () => backCalls.push(backCalls.length),
      });

      dispatch({
        type: "config-step",
        state: { step: "confirm-unset", key: "SERI_VERIFY_COMMAND" },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("[y]es");
      expect(frame).toContain("[N]o");
      expect(frame).toContain("Verify command (SERI_VERIFY_COMMAND)");
      expect(frame).toContain("! Unset");

      setup.mockInput.pressKey("z"); // unrecognised key
      await flush(setup);
      expect(unset).toEqual([]);
      expect(backCalls).toEqual([0]);

      dispatch({
        type: "config-step",
        state: { step: "confirm-unset", key: "SERI_VERIFY_COMMAND" },
      });
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);
      expect(unset).toEqual([]);
      expect(backCalls).toEqual([0, 1]);

      dispatch({
        type: "config-step",
        state: { step: "confirm-unset", key: "SERI_VERIFY_COMMAND" },
      });
      await flush(setup);
      setup.mockInput.pressKey("y");
      await flush(setup);

      expect(unset).toEqual(["SERI_VERIFY_COMMAND"]);
    });

    // configKeyInfo's fallback (state/commands.ts): a key with no CONFIG_KEY_INFO entry shows its
    // raw name as the label, since there is no human name for it — the confirm-unset prompt above
    // only ever exercises a known key, which alone doesn't cover this path.
    test("confirm-unset on an unrecognised key shows the raw key as its own label", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "config-step",
        state: { step: "confirm-unset", key: "SERI_SOME_OTHER_KEY" },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Unset SERI_SOME_OTHER_KEY (SERI_SOME_OTHER_KEY)");
    });

    // Same regression guard as the permissions panel's own truncation test below.
    test("a row count past the window budget truncates and shows a +N more footer", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "config-requested",
        rows: Array.from({ length: 15 }, (_, i) => ({
          key: `FAKE_KEY_${i}`,
          masked: "",
          source: "unset" as const,
          removable: false,
          kind: "string" as const,
        })),
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("FAKE_KEY_0");
      expect(frame).not.toContain("FAKE_KEY_14");
      expect(frame).toMatch(/\+\d+ more/);
    });

    // Regression guard: a panel re-mounted with a non-zero seeded `selected` (cli.ts's own
    // findIndex-computed seed after a save/unset/remove) used to always start its own window at
    // offset 0, scrolling the acted-on row's own `>` marker off-screen on a list longer than the
    // window, until the next arrow key. useListWindow now seeds its offset from the initial
    // selection via the same slideWindow rule an arrow press already uses.
    test("re-mounting with a non-zero seeded selection keeps that row's own marker in view", async () => {
      const { setup, dispatch } = await connect();

      const rows = Array.from({ length: 15 }, (_, i) => ({
        key: `FAKE_KEY_${i}`,
        masked: "",
        source: "unset" as const,
        removable: false,
        kind: "string" as const,
      }));
      dispatch({ type: "config-step", state: { step: "list", rows, selected: 12 } });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("> FAKE_KEY_12");
    });

    // Regression guard: `remaining` used to be `rows.length - visible.length`, which counts rows
    // hidden ABOVE the window too and stays flat at `rows.length - windowSize` for as long as the
    // window is full — the footer never counted down while scrolling toward the bottom, and never
    // reached 0 even once every remaining row was on screen.
    test("the +N more footer count decreases while scrolling down, reaching 0 at the bottom", async () => {
      const { setup, dispatch } = await connect();

      const rows = Array.from({ length: 15 }, (_, i) => ({
        key: `FAKE_KEY_${i}`,
        masked: "",
        source: "unset" as const,
        removable: false,
        kind: "string" as const,
      }));
      dispatch({ type: "config-requested", rows });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("+5 more");

      for (let i = 0; i < 14; i++) {
        setup.mockInput.pressArrow("down");
        await flush(setup);
      }

      const frame = setup.captureCharFrame();
      expect(frame).toContain("> FAKE_KEY_14");
      expect(frame).not.toContain("+0 more");
      expect(frame).not.toMatch(/\+\d+ more/);
    });

    // Regression guard: `windowSize` is recomputed live from useTerminalDimensions().height on
    // every render, but `offset` previously only changed via an explicit arrow press
    // (handleArrowKey) — a terminal resize that shrinks windowSize could leave the currently
    // selected row outside [offset, offset + windowSize) with no keypress to trigger a recompute.
    //
    // Also a regression guard on the transcript's own wrapping box (app.tsx's own header comment on
    // `flexBasis={0}`/`overflow="hidden"`): without `flexBasis={0}`, this box's own height stayed
    // hostage to the transcript scrollbox's previously-measured size across a resize too, not just a
    // panel mount, so it never converged to the smaller share this 3-row config window needs.
    test("a windowSize shrink after a selection move keeps the selected row in view without a keypress", async () => {
      const { setup, dispatch } = await connect();

      const rows = Array.from({ length: 15 }, (_, i) => ({
        key: `FAKE_KEY_${i}`,
        masked: "",
        source: "unset" as const,
        removable: false,
        kind: "string" as const,
      }));
      dispatch({ type: "config-requested", rows });
      await flush(setup);

      // Select row 9 — still inside the default (10-row) window, so offset stays 0.
      for (let i = 0; i < 9; i++) {
        setup.mockInput.pressArrow("down");
        await flush(setup);
      }
      expect(setup.captureCharFrame()).toContain("> FAKE_KEY_9");

      // Shrink to a 3-row window (listWindowSize(11 - APP_CHROME_ROWS) = 3) — with offset still 0,
      // row 9 would fall outside [0, 3) unless something re-clamps it.
      await resize(setup, DEFAULT_WIDTH, 11);

      expect(setup.captureCharFrame()).toContain("> FAKE_KEY_9");
    });

    // Regression guard: the resize effect re-slid `offset` via `slideWindow`, but that function
    // only moves `offset` when `selected` falls outside the window — an `offset` left over from a
    // smaller window survived a GROW unchanged even when `rows.length` now had room to show more.
    // Shrinks first (to push `offset` up near the end of the list), then grows back past the
    // shrunk offset, and checks the window actually widens instead of staying stuck at 5 visible
    // rows out of a 10-row budget.
    test("a windowSize grow after a shrink widens the window instead of leaving offset stale", async () => {
      const { setup, dispatch } = await connect();

      const rows = Array.from({ length: 15 }, (_, i) => ({
        key: `FAKE_KEY_${i}`,
        masked: "",
        source: "unset" as const,
        removable: false,
        kind: "string" as const,
      }));
      dispatch({ type: "config-requested", rows });
      await flush(setup);

      // Select row 12 — past the 10-row window, so offset slides to 3.
      for (let i = 0; i < 12; i++) {
        setup.mockInput.pressArrow("down");
        await flush(setup);
      }

      // Shrink to a 3-row window: offset slides to 10 (selected 12, windowSize 3).
      await resize(setup, DEFAULT_WIDTH, 11);
      // Negative control: at offset 10/windowSize 3, row 5 is well outside the window.
      expect(setup.captureCharFrame()).not.toContain("FAKE_KEY_5");

      // Grow back to a 10-row window with no keypress. offset 10 is stale — with 15 rows and a
      // 10-row window, the widest valid offset is 5 (rows.slice(5, 15)).
      await resize(setup, DEFAULT_WIDTH, DEFAULT_HEIGHT);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("> FAKE_KEY_12");
      expect(frame).toContain("FAKE_KEY_5");
    });

    // Regression guard: useListWindow's row budget used to reserve only the root box's own spare
    // row and the unconditional mode-indicator row (APP_CHROME_ROWS, util/format.ts) — not
    // commandError or AuthBanner, both of which can be showing at the same time as a panel. On a
    // 20-row terminal that overflowed the alt-screen viewport, unrecoverable until the panel closed
    // or the terminal resized (no scrollback on the alt screen).
    test("a panel opened under an auth banner and a command error still fits the viewport", async () => {
      const { setup, dispatch } = await connect();
      await resize(setup, DEFAULT_WIDTH, 20);

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "command-error", message: "boom" });
      // Row 0 is a known key (configKeyInfo has a description for it) so the selected row's
      // description line renders too, matching ConfigPanel's own tallest real case — a bare
      // FAKE_KEY row has no description and would silently under-count the panel's real height.
      const rows: ConfigRow[] = [
        configRows()[0] as ConfigRow,
        ...Array.from({ length: 14 }, (_, i) => ({
          key: `FAKE_KEY_${i}`,
          masked: "",
          source: "unset" as const,
          removable: false,
          kind: "string" as const,
        })),
      ];
      dispatch({ type: "config-requested", rows });
      await flush(setup);

      const frame = setup.captureCharFrame();
      // Content that doesn't fit the fixed-height root box doesn't grow the frame taller — an
      // under-reserved budget would either overlap two rows' worth of text or clip the panel's own
      // header line; both must render intact once the reservation accounts for AuthBanner and
      // commandError.
      expect(frame).toContain("⏸ approve-each mode on");
      expect(frame).toContain("/config — settings");
      expect(frame).toContain("Esc/Ctrl-D close");
    });
  });

  describe("permissions panel", () => {
    test("a removable: false row does not show a remove affordance in the frame", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "permissions-requested",
        rows: [{ tool: "read_file", source: "pre-approved", removable: false }],
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("read_file");
      expect(frame).toContain("not removable");
    });

    test("a removable: true row shows normally, without the not-removable note", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "permissions-requested",
        rows: [{ tool: "write_file", source: "persisted", removable: true }],
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("write_file");
      expect(frame).not.toContain("not removable");
    });

    // handleArrowKey's empty-list clamp (useListWindow.ts, Math.max(0, next)): pressing Down while
    // rows is [] must not leave the hook's selection at -1 for the SAME component instance once
    // rows arrive — useListWindow's useState only seeds from initialSelected on first mount, so a
    // second permissions-requested dispatch reuses the same internal state rather than resetting
    // it. Without the clamp, a negative offset makes `rows.slice(offset, ...)` read from the END
    // of the array instead of the start (JS negative-slice semantics) — with two rows that means
    // only the SECOND row renders at all, marked selected, and the first is missing from the frame
    // entirely; this asserts the first row renders, unmarked-if-second, marked-if-first.
    test("Down on an empty list does not leave the selection negative once rows arrive", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "permissions-requested", rows: [] });
      await flush(setup);
      setup.mockInput.pressArrow("down");
      await flush(setup);

      dispatch({
        type: "permissions-requested",
        rows: [
          { tool: "read_file", source: "pre-approved", removable: true },
          { tool: "write_file", source: "persisted", removable: true },
        ],
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("> read_file");
      expect(frame).toContain("  write_file");
    });

    // Review round 3 finding (MEDIUM-1's own test coverage gap), mirroring SetupPanel's own
    // confirm-remove test above: proves app.tsx's render call actually threads
    // onPermissionsRemove through to PermissionsPanel, not just that ConfirmPrompt's own 'y'
    // handling works.
    test("confirm-remove: 'y' calls onPermissionsRemove", async () => {
      const removed: string[] = [];
      const { setup, dispatch } = await connect({
        onPermissionsRemove: (tool) => removed.push(tool),
      });

      dispatch({
        type: "permissions-step",
        state: { step: "confirm-remove", tool: "write_file" },
      });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("! Remove write_file");

      setup.mockInput.pressKey("y");
      await flush(setup);

      expect(removed).toEqual(["write_file"]);
    });

    // useListWindow's own window budget (listWindowSize) — 15 rows, more than the default 10-row
    // window, so this must truncate and show the footer.
    test("a row count past the window budget truncates and shows a +N more footer", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "permissions-requested",
        rows: Array.from({ length: 15 }, (_, i) => ({
          tool: `tool_${i}`,
          source: "persisted" as const,
          removable: true,
        })),
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("tool_0");
      expect(frame).not.toContain("tool_14");
      expect(frame).toMatch(/\+\d+ more/);
    });

    // Regression guard: `remaining` used to be `rows.length - visible.length`, which counts rows
    // hidden ABOVE the window too and stays flat at `rows.length - windowSize` for as long as the
    // window is full — the footer never counted down while scrolling toward the bottom, and never
    // reached 0 even once every remaining row was on screen.
    test("the +N more footer count decreases while scrolling down, reaching 0 at the bottom", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "permissions-requested",
        rows: Array.from({ length: 15 }, (_, i) => ({
          tool: `tool_${i}`,
          source: "persisted" as const,
          removable: true,
        })),
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("+5 more");

      for (let i = 0; i < 14; i++) {
        setup.mockInput.pressArrow("down");
        await flush(setup);
      }

      const frame = setup.captureCharFrame();
      expect(frame).toContain("> tool_14");
      expect(frame).not.toMatch(/\+\d+ more/);
    });
  });

  // Render-ternary precedence (app.tsx's own comment): pendingApproval → pendingModelPicker →
  // pendingSetup → pendingAuth → pendingConfig → pendingPermissions → pendingEffort → InputBox.
  // Each test below seeds one adjacent pair at once and checks the earlier-in-the-chain branch
  // wins, extending the existing pendingSetup-vs-InputBox precedence test above to the three new
  // Stage A branches, and pendingEffort at the tail of the chain.
  describe("render precedence: pendingApproval / pendingSetup / pendingAuth / pendingConfig / pendingPermissions / pendingEffort", () => {
    test("pendingApproval wins over pendingAuth", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("Starting login");

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Approve write_file");
      expect(frame).not.toContain("Starting login");
    });

    test("pendingSetup wins over pendingAuth", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("Starting login");

      dispatch({ type: "setup-requested", rows: [] });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("/setup — provider API keys");
      expect(frame).not.toContain("Starting login");
    });

    test("pendingAuth wins over pendingConfig", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "config-requested",
        rows: [
          {
            key: "SERI_VERIFY_COMMAND",
            masked: "bun check",
            source: "config",
            removable: true,
            kind: "string",
          },
        ],
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("/config — settings");

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Starting login");
      expect(frame).not.toContain("/config — settings");
    });

    test("pendingConfig wins over pendingPermissions", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "permissions-requested",
        rows: [{ tool: "write_file", source: "persisted", removable: true }],
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("/permissions — tools approved permanently");

      dispatch({
        type: "config-requested",
        rows: [
          {
            key: "SERI_VERIFY_COMMAND",
            masked: "bun check",
            source: "config",
            removable: true,
            kind: "string",
          },
        ],
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("/config — settings");
      expect(frame).not.toContain("/permissions — tools approved permanently");
    });

    // Extends the chain one further link: pendingPermissions -> pendingEffort -> InputBox.
    test("pendingPermissions wins over pendingEffort", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "effort-requested", tiers: ["low", "medium", "high"], selected: 0 });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("/effort — reasoning effort");

      dispatch({
        type: "permissions-requested",
        rows: [{ tool: "write_file", source: "persisted", removable: true }],
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("/permissions — tools approved permanently");
      expect(frame).not.toContain("/effort — reasoning effort");
    });

    test("pendingEffort wins over InputBox", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "effort-requested", tiers: ["low", "medium", "high"], selected: 0 });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("/effort — reasoning effort");
    });
  });

  describe("subagent panel", () => {
    test("childWindowOffset keeps the first three children until the marker would leave the window", () => {
      const ids = ["a", "b", "c", "d", "e", "f"];
      expect(childWindowOffset("main", ids)).toBe(0);
      expect(childWindowOffset(undefined, ids)).toBe(0);
      expect(childWindowOffset("a", ids)).toBe(0);
      expect(childWindowOffset("c", ids)).toBe(0);
      expect(childWindowOffset("d", ids)).toBe(1);
      expect(childWindowOffset("f", ids)).toBe(3);
    });

    function childEvent(
      childId: string,
      role: ChildEventPayload["role"],
      goal: string,
      event: ChildEventPayload["event"],
    ) {
      return { type: "subagent-child-event" as const, childId, role, goal, event };
    }

    function startExplore(dispatch: Dispatch, childId: string, goal: string, file = "foo.ts") {
      dispatch(childEvent(childId, "explore", goal, { type: "child-started" }));
      dispatch(
        childEvent(childId, "explore", goal, {
          type: "tool-call",
          name: "read_file",
          args: { path: file },
        }),
      );
    }

    function panelBand(frame: string): {
      band: string;
      start: number;
      end: number;
      lines: string[];
    } {
      const lines = frame.split("\n");
      const start = lines.reduce((last, line, i) => (line.includes("─") ? i : last), -1);
      const end = lines.findIndex((line) => line.includes("approve-each mode on"));
      return { band: lines.slice(start + 1, end).join("\n"), start, end, lines };
    }

    test("two in-flight explore children render between InputBox and the mode row", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "loop-event",
        event: {
          type: "tool-call",
          name: "dispatch_subagents",
          args: { tasks: [{ role: "explore", goal: "find a" }] },
        },
      });
      startExplore(dispatch, "t1:0", "find a");
      startExplore(dispatch, "t1:1", "find b");
      await flush(setup);

      const frame = setup.captureCharFrame();
      const { band, start, end, lines } = panelBand(frame);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(band).toContain("explore");
      expect(band.includes("Read") || band.includes("foo.ts")).toBe(true);
      expect(band).not.toContain("dispatch_subagents");
      const panelLine = lines.findIndex(
        (line, i) => i > start && i < end && line.includes("explore"),
      );
      expect(panelLine).toBeGreaterThan(start);
      expect(panelLine).toBeLessThan(end);
    });

    test("the panel is absent when there are no child events", async () => {
      const { setup } = await connect();
      const { band, start, end } = panelBand(setup.captureCharFrame());
      expect(end).toBeGreaterThan(start);
      expect(band).not.toContain("explore");
    });

    test("parent dispatch tool-result hides the panel and skips the dispatch settled line", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      startExplore(dispatch, "t1:0", "find a");
      startExplore(dispatch, "t1:1", "find b");
      await flush(setup);
      expect(panelBand(setup.captureCharFrame()).band).toContain("explore");
      dispatch({
        type: "loop-event",
        event: {
          type: "tool-result",
          name: "dispatch_subagents",
          result: {
            results: [{ doneReason: "no-tool-call" }, { doneReason: "no-tool-call" }],
            totalUsage: { totalTokens: 15 },
          },
        },
      });
      dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(panelBand(frame).band).not.toContain("explore");
      expect(panelBand(frame).band).not.toContain("main");
      expect(frame).toContain("done ·");
      expect(frame).not.toContain("✓ Dispatched subagents done");
      expect(frame).not.toContain("read_file");
    });

    test("six live children paint main, at most three child rows, and +n", async () => {
      const { setup, dispatch } = await connect();
      for (let i = 0; i < 6; i++) {
        startExplore(dispatch, `t1:${i}`, `find ${i}`, `f${i}.ts`);
      }
      await flush(setup);

      const bandLines = panelBand(setup.captureCharFrame()).band.split("\n");
      const exploreRows = bandLines.filter((line) => line.includes("explore"));
      expect(exploreRows.length).toBeGreaterThan(0);
      expect(exploreRows.length).toBeLessThanOrEqual(3);
      expect(panelBand(setup.captureCharFrame()).band).toContain("main");
      expect(panelBand(setup.captureCharFrame()).band).toMatch(/\+\d/);

      setup.mockInput.pressArrow("down");
      await flush(setup);
      for (let i = 0; i < 6; i++) {
        setup.mockInput.pressArrow("down");
        await flush(setup);
      }
      expect(panelBand(setup.captureCharFrame()).band).toContain("f5.ts");
    });

    test("an archivist note still renders and does not open the panel", async () => {
      const { setup, dispatch } = await connect();
      dispatch({
        type: "transcript-append",
        line: `${ARCHIVIST_MARK}(archivist: tool-count trigger, 1 tool call)`,
        muted: true,
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain(ARCHIVIST_MARK);
      expect(frame).toContain("(archivist:");
      expect(panelBand(frame).band).not.toContain("explore");
    });

    test("empty InputBox Down focuses the panel; Esc blurs", async () => {
      const { setup, dispatch } = await connect();
      startExplore(dispatch, "t1:0", "find a");
      await flush(setup);

      expect(panelBand(setup.captureCharFrame()).band).not.toContain("> ");
      setup.mockInput.pressArrow("down");
      await flush(setup);
      expect(panelBand(setup.captureCharFrame()).band).toContain("> ");

      setup.mockInput.pressEscape();
      // A bare Escape byte is ambiguous with the start of a longer ANSI sequence (an arrow key,
      // say), so OpenTUI's own parser holds it for a short disambiguation window before treating it
      // as a standalone Escape keypress — longer than the plain macrotask tick `flush()` waits.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flush(setup);
      const afterBlur = setup.captureCharFrame();
      expect(panelBand(afterBlur).band).not.toContain("> ");
      expect(afterBlur).toContain("─");
    });

    test("non-empty InputBox Down does not focus the panel", async () => {
      const { setup, dispatch } = await connect();
      startExplore(dispatch, "t1:0", "find a");
      await flush(setup);

      await setup.mockInput.typeText("x");
      await flush(setup);
      setup.mockInput.pressArrow("down");
      await flush(setup);
      expect(panelBand(setup.captureCharFrame()).band).not.toContain("> ");
    });

    test("Enter swaps the scrollbox and Esc blurs without unmounting the roster", async () => {
      const { setup, dispatch } = await connect();
      startExplore(dispatch, "t1:0", "find UNIQUE_GOAL");
      await flush(setup);

      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);

      const viewing = setup.captureCharFrame();
      expect(viewing).toContain("─");
      expect(viewing).toContain("Read");
      expect(viewing).toContain("explore");
      expect(viewing).toContain("UNIQUE_GOAL");

      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flush(setup);
      const afterEsc = setup.captureCharFrame();
      expect(afterEsc).toContain("─");
      expect(panelBand(afterEsc).band).toContain("explore");
      expect(afterEsc).toContain("UNIQUE_GOAL");
    });

    test("after parent flush with a child view open the roster unmounts and the parent transcript returns", async () => {
      const { setup, dispatch } = await connect();
      startExplore(dispatch, "t1:0", "find a", "a.ts");
      startExplore(dispatch, "t1:1", "find b", "b.ts");
      await flush(setup);

      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);

      dispatch({
        type: "loop-event",
        event: {
          type: "tool-result",
          name: "dispatch_subagents",
          result: {
            results: [{ doneReason: "no-tool-call" }, { doneReason: "no-tool-call" }],
            totalUsage: { totalTokens: 15 },
          },
        },
      });
      dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
      await flush(setup);

      const afterFlush = setup.captureCharFrame();
      expect(afterFlush).toContain("─");
      expect(afterFlush).not.toContain("✓ Dispatched subagents done");
      expect(panelBand(afterFlush).band).not.toContain("explore");
      expect(panelBand(afterFlush).band).not.toContain("main");
    });

    test("the second child is still in the frame while a child is viewed", async () => {
      const { setup, dispatch } = await connect();
      startExplore(dispatch, "t1:0", "find a", "alpha.ts");
      startExplore(dispatch, "t1:1", "find b", "beta.ts");
      await flush(setup);

      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("─");
      expect(frame).toContain("Read");
      expect(frame).toContain("alpha.ts");
      expect(panelBand(frame).band).toContain("explore");
      expect(frame).toContain("beta.ts");
    });

    test("a live row does not paint the prompt and a long header stays one row", async () => {
      const { setup, dispatch } = await connect();
      const longGoal = `Your job: ${"do the thing. ".repeat(20)}`;
      expect(longGoal.length).toBeGreaterThan(200);
      startExplore(dispatch, "t1:0", longGoal);
      await flush(setup);

      expect(panelBand(setup.captureCharFrame()).band).not.toContain("Your job");

      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);

      const frame = setup.captureCharFrame();
      const headerLines = frame.split("\n").filter((line) => line.includes("Your job"));
      expect(headerLines.length).toBeLessThanOrEqual(1);
    });

    test("two explores are both named explore with no ordinals", async () => {
      const { setup, dispatch } = await connect();
      startExplore(dispatch, "t1:0", "find a");
      startExplore(dispatch, "t1:1", "find b");
      await flush(setup);

      const { band } = panelBand(setup.captureCharFrame());
      expect(band.split("explore").length - 1).toBe(2);
      expect(band).not.toContain("· 1");
      expect(band).not.toContain("· 2");
    });

    test("main is in the band, Up selects it, and Enter on main restores the parent scrollbox", async () => {
      const { setup, dispatch } = await connect();
      startExplore(dispatch, "t1:0", "find UNIQUE_MAIN");
      startExplore(dispatch, "t1:1", "find b");
      await flush(setup);

      expect(panelBand(setup.captureCharFrame()).band).toContain("main");

      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("UNIQUE_MAIN");

      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressArrow("up");
      await flush(setup);
      expect(panelBand(setup.captureCharFrame()).band).toContain("> main");

      setup.mockInput.pressEnter();
      await flush(setup);
      const afterMain = setup.captureCharFrame();
      expect(afterMain).not.toContain("UNIQUE_MAIN");
      expect(panelBand(afterMain).band).toContain("explore");
      expect(afterMain).toContain("─");
    });

    test("empty Down on an inert InputBox while a child is viewed focuses the roster", async () => {
      const { setup, dispatch } = await connect();
      startExplore(dispatch, "t1:0", "find a");
      await flush(setup);

      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);
      expect(panelBand(setup.captureCharFrame()).band).not.toContain("> ");

      setup.mockInput.pressArrow("down");
      await flush(setup);
      expect(panelBand(setup.captureCharFrame()).band).toContain("> ");
    });
  });
  // The queue is the only surface between the transcript and the input box, so most of what matters
  // here is position and what a keypress reaches — both only observable against a real frame.
  describe("message queue", () => {
    async function withQueue(...items: string[]) {
      const connected = await connect();
      for (const text of items) {
        connected.dispatch({ type: "queue-appended", id: text, text });
      }
      await flush(connected.setup);
      return connected;
    }

    // Row index of the first line containing `needle`, so ordering can be asserted rather than mere
    // containment: "the queue is on screen" and "the queue is above the input box" are different
    // claims and only the second one is the design.
    function rowOf(frame: string, needle: string): number {
      return frame.split(String.fromCharCode(10)).findIndex((line) => line.includes(needle));
    }

    test("an empty queue draws nothing at all", async () => {
      const { setup } = await connect();
      expect(setup.captureCharFrame()).not.toContain("queued");
    });

    test("a queued message renders above the input box and below the transcript", async () => {
      const { setup, dispatch } = await withQueue("then open a PR");
      dispatch({ type: "transcript-append", line: "> earlier task", role: "user" });
      await flush(setup);

      const frame = setup.captureCharFrame();
      const transcript = rowOf(frame, "earlier task");
      const header = rowOf(frame, "1 queued");
      const row = rowOf(frame, "then open a PR");
      const inputBox = rowOf(frame, "⏸ approve-each mode on");

      expect(transcript).toBeGreaterThanOrEqual(0);
      expect(transcript).toBeLessThan(header);
      expect(header).toBeLessThan(row);
      expect(row).toBeLessThan(inputBox);
    });

    test("the depth label counts, and the key legend names the keys that are live", async () => {
      const { setup } = await withQueue("a", "b");
      const frame = setup.captureCharFrame();
      expect(frame).toContain("2 queued");
      expect(frame).toContain("ctrl+e edit");
      expect(frame).toContain("ctrl+x drop");
    });

    // The mode row's own rule, applied to this row: when both halves of a space-between row do not
    // fit, the hint loses rather than the row wrapping onto a line the block has not budgeted.
    test("the key legend is dropped on a terminal too narrow for both halves", async () => {
      const { setup } = await withQueue("a");
      await resize(setup, 40, DEFAULT_HEIGHT);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("1 queued");
      expect(frame).not.toContain("ctrl+x drop");
    });

    test("ctrl+down and ctrl+n both move the band, and ctrl+up moves it back", async () => {
      const { setup } = await withQueue("first one", "second one");
      const banded = (frame: string) =>
        frame.split(String.fromCharCode(10)).find((line) => line.includes("second one"));

      setup.mockInput.pressArrow("down", { ctrl: true });
      await flush(setup);
      expect(rowOf(setup.captureCharFrame(), "second one")).toBeGreaterThanOrEqual(0);
      expect(banded(setup.captureCharFrame())).toBeDefined();

      setup.mockInput.pressArrow("up", { ctrl: true });
      await flush(setup);
      setup.mockInput.pressKey("n", { ctrl: true });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("second one");
    });

    test("a plain arrow key does not move the band, so typing is unaffected", async () => {
      const { setup } = await withQueue("a", "b");
      setup.mockInput.pressArrow("down");
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("2 queued");
    });

    test("ctrl+x drops the selected row and renumbers the rest", async () => {
      const { setup } = await withQueue("first one", "second one");
      setup.mockInput.pressKey("x", { ctrl: true });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("1 queued");
      expect(frame).toContain("second one");
      expect(frame).not.toContain("first one");
    });

    // Ctrl-D keeps the one meaning AGENTS.md and spec 038 give it, in the queue and out of it —
    // which is why drop is ctrl+x and not the ctrl+d the issue's simulation proposed.
    test("ctrl+d still quits while the queue is non-empty", async () => {
      const quits: number[] = [];
      const { setup, dispatch } = await connect({ onQuit: () => quits.push(1) });
      dispatch({ type: "queue-appended", id: "q0", text: "still queued" });
      await flush(setup);

      setup.mockInput.pressKey("d", { ctrl: true });
      await flush(setup);

      expect(quits).toEqual([1]);
      expect(setup.captureCharFrame()).toContain("1 queued");
    });

    test("ctrl+e opens the row for editing and the main input box keeps its own draft", async () => {
      const { setup } = await withQueue("queued text");
      await setup.mockInput.typeText("half typed");
      // InputBox coalesces a burst behind its own 50ms throttle and paints only the leading-edge
      // character until it fires, so a frame captured before then shows "> h" and proves nothing
      // about whether the draft survived.
      await new Promise((resolve) => setTimeout(resolve, 70));
      await flush(setup);

      setup.mockInput.pressKey("e", { ctrl: true });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("queued text");
      expect(frame).toContain("half typed");
    });

    test("a keystroke during an edit reaches the row, not the main input box", async () => {
      const { setup } = await withQueue("queued");
      setup.mockInput.pressKey("e", { ctrl: true });
      await flush(setup);

      await setup.mockInput.typeText("!");
      await flush(setup);
      await new Promise((resolve) => setTimeout(resolve, 70));
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("queued!");
      expect(frame).not.toContain("> !");
    });

    test("the band does not move while a row is being edited", async () => {
      const { setup } = await withQueue("first one", "second one");
      setup.mockInput.pressKey("e", { ctrl: true });
      await flush(setup);
      setup.mockInput.pressArrow("down", { ctrl: true });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("first one");
    });

    test("six queued messages paint five rows and a +1", async () => {
      const { setup } = await withQueue("m1", "m2", "m3", "m4", "m5", "m6");
      const frame = setup.captureCharFrame();
      expect(frame).toContain("6 queued");
      expect(frame).toContain("+1");
      expect(frame).not.toContain("m6");
    });

    // A multi-line paste queues its first line and leaves the rest in the box, so a queued message
    // really can carry a newline — and one row per queued message is what the window budget counts.
    test("a queued message containing a newline still renders as one row", async () => {
      const { setup } = await withQueue(`line one${String.fromCharCode(10)}line two`);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("line one line two");
      expect(rowOf(frame, "line one")).toBe(rowOf(frame, "line two"));
    });
  });
});
