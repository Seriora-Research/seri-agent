/** @jsxImportSource @opentui/react */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseColor, type Renderable, RGBA, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import type { ReactElement, ReactNode } from "react";
import { GROK_BORROWED_CLIENT_WARNING } from "../../src/auth/xaiConnect";
import { buildFileChange } from "../../src/fileChange";
import type { PermissionMode } from "../../src/gate/gate";
import type { ApprovalAnswer } from "../../src/loop/loop";
import type { ChildEventPayload } from "../../src/subagents/dispatch";
import { App, type AppProps } from "../../src/tui/app";
import { childWindowOffset } from "../../src/tui/components/SubagentPanel";
import type {
  ConfigRow,
  ModelPickerEntry,
  SetupKeyRow,
  SetupProviderRow,
} from "../../src/tui/state/commands";
import type { Dispatch } from "../../src/tui/state/reducer";
import { ARCHIVIST_MARK, ERROR_MARK, TREE_BRANCH, theme } from "../../src/tui/theme/theme";
import { ListRow } from "../../src/tui/ui/ListRow";
import {
  APP_CHROME_ROWS,
  DEFAULT_COLUMNS,
  formatContextWindow,
  formatCost,
  formatModelPickerHeader,
  formatModelRow,
  formatRouteLabel,
  formatSetupRow,
  listWindowSize,
  MODE_CYCLE_HINT,
  MODE_HINT_COLS,
  MODE_LABEL,
  matchesFilter,
  NAME_WIDTH,
  PLAN_MODE_LABEL,
  PLAN_MODE_LEAVE_HINT,
  pickerLabelWidth,
  singleLine,
  slideWindow,
} from "../../src/tui/util/format";
import { OVERSCAN_ROWS } from "../../src/tui/util/visibleTranscriptWindow";
import { catalogEntry, catalogOf, flush, flushMarkdown, route, session } from "./helpers";

// 100×30: leftover mode-row detail always fits, and height ≥24 puts every panel list at LIST_WINDOW_MAX (10) without each test resizing.
const DEFAULT_WIDTH = 100;
const DEFAULT_HEIGHT = 30;

// Each connect() registers on the process-wide TerminalConsoleCache singleton; 140+ tests cross Node's 10-listener warning if nothing destroys them.
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

// A resize chains two commits (terminal-dimensions, then onSizeChange); one flush() only sees the first.
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
      onSubmit={() => {}}
      {...overrides}
      connectDispatch={(d) => {
        dispatch = d;
        overrides.connectDispatch?.(d);
      }}
    />,
  );
  // connectDispatch's useEffect can land later than flush's two passes under CPU contention; waitFor polls the renderer scheduler.
  await setup.waitFor(() => dispatch !== undefined);
  if (dispatch === undefined) throw new Error("connectDispatch never fired");
  return { setup, dispatch };
}

function findScrollBox(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable) return node;
  for (const child of node.getChildren()) {
    const found = findScrollBox(child);
    if (found) return found;
  }
}

// Row wrappers have children; spacer boxes do not. SplashBanner is not mounted in `connect()`.
function mountedTranscriptRowCount(setup: TestRendererSetup): number {
  const scrollBox = findScrollBox(setup.renderer.root);
  if (scrollBox === undefined) throw new Error("no scrollbox");
  return scrollBox.content.getChildren().filter((child) => child.getChildren().length > 0).length;
}

// Bytes OpenTUI's parser maps to pageup/shift-tab (HOME/END/DELETE are mockInput named keys), not covered by mockInput helpers.
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

  test("the mode row renders below the input box, not above it", async () => {
    const { setup } = await connect({ session: session({ permissionMode: "read-only" }) });
    const lines = setup.captureCharFrame().split("\n");
    const modeLineIndex = lines.findIndex((l) => l.includes("read-only mode on"));
    const inputBottomBorderIndex = lines.reduce((last, l, i) => (l.includes("─") ? i : last), -1);
    expect(inputBottomBorderIndex).toBeGreaterThan(-1);
    expect(modeLineIndex).toBeGreaterThan(inputBottomBorderIndex);
  });

  test("borders render with square corners, not rounded ones", async () => {
    const { setup } = await connect();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("─");
    expect(frame).not.toContain("╭");
  });

  test("InputBox is a full four-side box — vertical rules and all four corner glyphs", async () => {
    const { setup } = await connect();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("─");
    expect(frame).toContain("│");
    expect(frame).toContain("┌");
    expect(frame).toContain("┐");
    expect(frame).toContain("└");
    expect(frame).toContain("┘");
  });

  test("an App with nowhere to send input does not echo what is typed at it", async () => {
    const { setup } = await connect({ onSubmit: undefined });
    // useKeyboard needs one more settled pass than mount, and InputBox's 50ms throttle holds everything after the leading-edge keystroke.
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

  // Four CJK characters are 8 display cells, not 4; ASCII cannot tell a wide-character-aware band from a count-by-code-unit one.
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

  // OpenTUI <text> must keep an empty string as one visual row, not zero height; two one-line entries with exactly one row between them pin that.
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

  // 300 lines is more than the fixed viewport, so the slice on screen must be the newest end.
  test("a transcript longer than the viewport shows the newest line and hides the oldest, with InputBox still visible", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("line 299");
    expect(frame).not.toContain("line 0");
    expect(frame).toContain("─");
  });

  // 200 one-line entries exceed a 30-row viewport; spacers have no children, row wrappers do.
  test("a long transcript mounts O(viewport+overscan) rows, not every historical entry", async () => {
    const { setup, dispatch } = await connect();
    const n = 200;
    for (let i = 0; i < n; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush(setup);

    const mounted = mountedTranscriptRowCount(setup);
    expect(mounted).toBeLessThan(n);
    expect(mounted).toBeLessThanOrEqual(OVERSCAN_ROWS * 2 + DEFAULT_HEIGHT + 16);
    expect(setup.captureCharFrame()).toContain("line 199");
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

  // With mouse reporting off, a real wheel notch arrives as Up/Down, not as an OpenTUI mouse-scroll event.
  test("Up arrow scrolls the transcript the way a wheel notch does once mouse reporting is off", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush(setup);
    expect(setup.captureCharFrame()).not.toContain("↑ scrolled");
    expect(setup.captureCharFrame()).toContain("line 299");

    for (let i = 0; i < 8; i++) {
      setup.mockInput.pressArrow("up");
      await flush(setup);
    }

    const frame = setup.captureCharFrame();
    expect(frame).toContain("↑ scrolled — End to follow");
    expect(frame).not.toContain("line 299");
  });

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

  test("PageUp while an approval is pending scrolls the transcript and shows the banner", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    dispatch({
      type: "approval-requested",
      toolName: "write_file",
      args: { path: "a.txt" },
      offersAlways: true,
    });
    await flush(setup);
    expect(setup.captureCharFrame()).toContain("Write a.txt?");

    setup.mockInput.pressKey(PAGE_UP);
    await flush(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("↑ scrolled — End to follow");
    expect(frame).not.toContain("line 299");
    expect(frame).toContain("Write a.txt?");

    setup.mockInput.pressKey(END);
    await flush(setup);
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("↑ scrolled");
    expect(frame).toContain("line 299");
    expect(frame).toContain("Write a.txt?");
  });

  test("PageUp behind an approval that arrived over an open panel still scrolls the transcript", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    dispatch({
      type: "model-picker-requested",
      entries: [
        {
          entry: catalogEntry(),
          keyConfigured: true,
          alternatives: 0,
          gatewayReachable: false,
          subscriptionCovered: false,
        },
      ],
    });
    dispatch({
      type: "approval-requested",
      toolName: "write_file",
      args: { path: "a.txt" },
      offersAlways: true,
    });
    await flush(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("Write a.txt?");
    expect(frame).not.toContain('Type to filter — try "included", "free" or "paid"…');

    setup.mockInput.pressKey(PAGE_UP);
    await flush(setup);
    frame = setup.captureCharFrame();
    expect(frame).toContain("↑ scrolled — End to follow");
    expect(frame).not.toContain("line 299");
    expect(frame).toContain("Write a.txt?");
  });

  test("PageUp while the model picker is open does not scroll the transcript in the background", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    dispatch({
      type: "model-picker-requested",
      entries: [
        {
          entry: catalogEntry(),
          keyConfigured: true,
          alternatives: 0,
          gatewayReachable: false,
          subscriptionCovered: false,
        },
      ],
    });
    await flush(setup);

    setup.mockInput.pressKey(PAGE_UP);
    await flush(setup);
    expect(setup.captureCharFrame()).not.toContain("↑ scrolled");

    dispatch({ type: "model-picker-resolved" });
    await flush(setup);
    const pickerClosed = setup.captureCharFrame();
    expect(pickerClosed).not.toContain("↑ scrolled");
    expect(pickerClosed).toContain("line 299");
  });

  // With mouse reporting off the thumb still paints █▀▄ into the last column, which trailing-whitespace trim does not strip.
  test("nothing paints the transcript's last column when the content overflows", async () => {
    const { setup, dispatch } = await connect();

    const transcriptRightEdge = (frame: string) => {
      const lines = frame.split("\n");
      const inputBoxTop = lines.findIndex((l) => l.includes("─"));
      return lines
        .slice(0, inputBoxTop)
        .map((l) => l.at(-1) ?? "")
        .join("");
    };

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush(setup);
    expect(transcriptRightEdge(setup.captureCharFrame()).length).toBeGreaterThan(0);
    expect(transcriptRightEdge(setup.captureCharFrame()).trim()).toBe("");

    setup.mockInput.pressKey(PAGE_UP);
    await flush(setup);
    expect(transcriptRightEdge(setup.captureCharFrame()).trim()).toBe("");

    setup.mockInput.pressKey(HOME);
    await flush(setup);
    expect(transcriptRightEdge(setup.captureCharFrame()).trim()).toBe("");
  });

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

  // 300 lines, not a short answer: overflow="hidden" clips from the top, so "answer line 0" survives a broken build and only the tail ("answer line 299") proves reachability.
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

  test("no partial assistant text renders while a turn is active, scrolled up or following the tail", async () => {
    const { setup, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
    await flush(setup);

    setup.mockInput.pressKey(PAGE_UP);
    await flush(setup);
    expect(setup.captureCharFrame()).toContain("↑ scrolled");
    for (let i = 0; i < 5; i++) {
      dispatch({ type: "loop-event", event: { type: "text-delta", text: `chunk ${i}\n` } });
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("chunk");
    }

    setup.mockInput.pressKey(END);
    await flush(setup);
    for (let i = 5; i < 10; i++) {
      dispatch({ type: "loop-event", event: { type: "text-delta", text: `chunk ${i}\n` } });
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("chunk");
    }
  });

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

  test("N text-deltas without flush do not re-invoke getCompletionSources; done still concatenates every chunk", async () => {
    let n = 0;
    const { setup, dispatch } = await connect({
      getCompletionSources: () => {
        n++;
        return [];
      },
    });
    dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
    await flush(setup);
    const afterTurn = n;
    for (let i = 0; i < 30; i++) {
      dispatch({ type: "loop-event", event: { type: "text-delta", text: `chunk ${i} ` } });
    }
    // helpers.flush also calls renderOnce, which can re-invoke App with no pending update; one timer tick lets a scheduled reducer commit run without forcing that paint.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(n).toBe(afterTurn);
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    await flushMarkdown(setup, (frame) => frame.includes("chunk 0") && frame.includes("chunk 29"));
    expect(setup.captureCharFrame()).toContain("chunk 0");
    expect(setup.captureCharFrame()).toContain("chunk 29");
  });

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
      // The shrink's layout-changed fires with a stale scrollTop before the scrollbox clamp catches up; the second pass, once Yoga has settled, corrects a spurious scrolledUp.
      await flush(setup);
      await flush(setup);

      expect(setup.captureCharFrame()).not.toContain("↑ scrolled");
    });

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


    test("duplicate/out-of-order turn-lifecycle dispatches do not move a scrolled-up reader's view", async () => {
      const { setup, dispatch } = await connect();

      for (let i = 0; i < 50; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);
      setup.mockInput.pressKey(HOME);
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("line 0");

      dispatch({ type: "turn-ended" });
      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("line 0");
      expect(setup.captureCharFrame()).toContain("↑ scrolled");
    });

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

    test("TurnStatus stays visible during an active turn even on a terminal too short for the transcript too", async () => {
      const { setup, dispatch } = await connect();
      await resize(setup, DEFAULT_WIDTH, 5);

      dispatch({ type: "turn-started", startedAt: Date.now(), inputEstimate: 0 });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toMatch(/\d+s .*↑, .*↓/);
      expect(frame).not.toContain("─".repeat(DEFAULT_WIDTH));
    });
  });

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
    // MarkdownRenderable's content tree does not settle top-to-bottom; the table can render before the heading, so polling one block can read a partial frame as done.
    await flushMarkdown(
      setup,
      (frame) =>
        frame.includes("Heading") &&
        frame.includes("bold text") &&
        frame.includes("item one") &&
        frame.includes("celly"),
    );

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("# Heading");
    expect(frame).not.toContain("**bold text**");
    expect(frame).not.toContain("[link](https://example.com)");
    expect(frame).not.toContain("```");
    expect(frame).toContain("Heading");
    expect(frame).toContain("bold text");
    expect(frame).toContain("link");
    expect(frame).toContain("item one");
    expect(frame).toContain("item two");
    expect(frame).toContain("const x = 1;");
    expect(frame).toContain("cellx");
    expect(frame).toContain("celly");
  });

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

  // @opentui/core's table path never forwarded the markdown fg, so cells fell back to hardcoded white; header and bold chunks are distinct code paths that a default-scope-only fix still leaves white.
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

  // Same clip, issue #161: a long bare URL with no code-span markup.
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

  // Content that already fit must stay on exactly one row: markdown paddingLeft plus the scrollbox's paddingLeft={1} put the bullet at column 1, not 0.
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

  // Two flushMarkdown cycles each budget 3000ms; an explicit timeout above bun's 5000ms default so a slow runner reports this failure instead of "test timed out".
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

  // The post-resize predicate must require the row count to drop: the word-count condition was already true, so it can return before Yoga's re-layout and read a stale narrow frame.
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

  test("a whitespace-only assistant message still renders its bullet", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "loop-event", event: { type: "text-delta", text: "\n" } });
    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);
    await flushMarkdown(setup, (frame) => frame.includes("●"));

    expect((setup.captureCharFrame().match(/●/g) ?? []).length).toBe(1);
  });

  // Width 5 is under TRANSCRIPT_PADDING_MIN_WIDTH and was a confirmed-broken width where stacked padding left markdown nothing to render.
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

  test("a short transcript top-anchors: content appears near the top of the frame, not bottom-padded", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "transcript-append", line: "hello" });
    await flush(setup);

    const lines = setup.captureCharFrame().split("\n");
    const contentIndex = lines.findIndex((line) => line.includes("hello"));
    expect(contentIndex).toBeGreaterThanOrEqual(0);
    expect(contentIndex).toBeLessThan(3);
  });

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
    expect(setup.captureCharFrame()).toContain("→ Read(a.txt)");
  });

  test("session-updated refreshes the mode indicator shown", async () => {
    const { setup, dispatch } = await connect();

    dispatch({ type: "session-updated", session: session({ permissionMode: "auto" }) });
    await flush(setup);

    expect(setup.captureCharFrame()).toContain("⏵⏵ bypass permissions on");
  });

  // Under OpenTUI a paste is a bracketed-paste event, never the keyboard handler; an embedded \r/\n must still submit at the first line.
  test("a pasted chunk with an embedded newline submits at the first line, not silently swallowing it", async () => {
    const submitted: string[] = [];
    const { setup } = await connect({ onSubmit: (v) => submitted.push(v) });

    await setup.mockInput.pasteBracketedText("first line\nsecond line");
    await flush(setup);

    expect(submitted).toEqual(["first line"]);
    expect(setup.captureCharFrame()).toContain("second line");
  });

  // A Windows-clipboard \r\n pair is one terminator; stripping only \r would leave a stray leading \n.
  test("a pasted chunk with a CRLF terminator does not leave a stray newline in the retained input", async () => {
    const submitted: string[] = [];
    const { setup } = await connect({ onSubmit: (v) => submitted.push(v) });

    await setup.mockInput.pasteBracketedText("first line\r\nsecond line");
    await flush(setup);

    expect(submitted).toEqual(["first line"]);
    setup.mockInput.pressEnter();
    await flush(setup);
    expect(submitted).toEqual(["first line", "second line"]);
  });

  test("the pending-tool box names the file, not a JSON dump of the body", async () => {
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

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Write a.txt");
    expect(frame).not.toContain("x".repeat(40));
    expect(frame).not.toContain("write_file(");
  });

  test("the pending-tool box carries no warning mark — it is not an alert", async () => {
    const { setup, dispatch } = await connect();

    dispatch({
      type: "loop-event",
      event: { type: "tool-call", name: "write_file", args: { path: "a.txt", content: "x" } },
    });
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Write a.txt");
    expect(frame).not.toContain("write_file(");
    expect(frame).not.toContain("! write_file");
  });

  test("a settled write_file paints capped hunks in the transcript", async () => {
    const { setup, dispatch } = await connect();
    const change = buildFileChange("Write a.txt", "old", "new");

    dispatch({
      type: "loop-event",
      event: {
        type: "tool-call",
        name: "write_file",
        args: { path: "a.txt", content: "new" },
      },
    });
    dispatch({
      type: "loop-event",
      event: { type: "tool-result", name: "write_file", result: { written: true, change } },
    });
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Write a.txt");
    expect(frame).toContain("old");
    expect(frame).toContain("new");
    expect(frame).toContain("+1 −1");
    expect(frame).not.toContain("- old");
    expect(frame).not.toContain("+ new");
  });

  test("a pending edit paints its hunk in the transcript as soon as the tool-call arrives", async () => {
    const { setup, dispatch } = await connect();

    dispatch({
      type: "loop-event",
      event: {
        type: "tool-call",
        name: "edit",
        args: { content: "keep\nold\n", oldString: "old", newString: "new" },
      },
    });
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("old");
    expect(frame).toContain("new");
    expect(frame).not.toContain("oldString");
    expect(frame).not.toContain("- old");
  });

  test("edit hunks stay on screen after done and do not paint twice", async () => {
    const { setup, dispatch } = await connect();

    dispatch({
      type: "loop-event",
      event: {
        type: "tool-call",
        name: "edit",
        args: { content: "keep\nold\n", oldString: "old", newString: "new" },
      },
    });
    dispatch({
      type: "loop-event",
      event: { type: "tool-result", name: "edit", result: "keep\nnew\n" },
    });
    await flush(setup);
    expect(setup.captureCharFrame()).toContain("old");
    expect(setup.captureCharFrame()).toContain("new");

    dispatch({ type: "loop-event", event: { type: "done", reason: "no-tool-call" } });
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("old");
    expect(frame).toContain("new");
    expect(frame).not.toContain("Edited 1 edit");
    expect(frame).toContain("+1");
    expect(countNeedle(frame, "+1")).toBe(1);
    expect(countNeedle(frame, "old")).toBe(1);
    expect(countNeedle(frame, "new")).toBe(1);
  });

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
      expect(frame).toContain("→ Read(a.txt)");
      expect(frame).toContain("Read 1 file");
      expect(frame).not.toContain("Running read_file…");
      expect(frame).not.toContain("(done:");
      const spans = setup.captureSpans();
      for (const text of ["→ Read(a.txt)", "Read 1 file"]) {
        const line = spans.lines.find((l) => l.spans.some((s) => s.text.includes(text)));
        const span = line?.spans.find((s) => s.text.includes(text));
        expect(span, `no span found containing ${text}`).toBeDefined();
        expect(span?.fg.equals(parseColor(theme.muted))).toBe(true);
      }
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
      expect(setup.captureCharFrame()).toContain("→ Grep(TODO)");

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
      expect(frame).toContain("→ Grep(TODO)");
      expect(frame).toContain("→ Read(a.txt)");
      expect(frame).not.toContain("(done:");
    });

    test("after done, the live tree collapses to one count line", async () => {
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
      expect(frame).not.toContain("→ Read");
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
      expect(frame).toContain("→ Read(a.txt)");
      expect(frame).toContain("Read 1 file");
      expect(frame).toContain("compaction failed");
      expect(frame).toContain(ERROR_MARK.trim());
      expect(frame).not.toContain("(done:");
    });

    test("a thrown read_file paints as a file-not-found anomaly, not a raw dump", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "loop-event",
        event: { type: "tool-call", name: "read_file", args: { path: join("docs", "ROADMAP.md") } },
      });
      dispatch({
        type: "loop-event",
        event: {
          type: "error",
          error: `Tool "read_file" threw during execution: Error: ENOENT: no such file or directory, open 'C:\\\\Users\\\\x\\\\docs\\\\ROADMAP.md'`,
        },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain(`→ Read(${join("docs", "ROADMAP.md")})`);
      expect(frame).toContain(`${TREE_BRANCH}file not found`);
      expect(frame).not.toContain("threw during execution");
      expect(frame).not.toContain("ENOENT");
    });
  });

  test("Ctrl-D calls onQuit", async () => {
    let quit = false;
    const { setup } = await connect({ onQuit: () => (quit = true) });

    setup.mockInput.pressKey("d", { ctrl: true });
    await flush(setup);

    expect(quit).toBe(true);
  });

  describe("approval prompt", () => {
    test("renders in place of the input box as a prose question, not a JSON dump", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: { path: "a.txt", content: "x" },
        offersAlways: true,
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Write a.txt?");
      expect(frame).toContain("[y]es");
      expect(frame).toContain("[a]lways");
      expect(frame).toContain("[N]o");
      expect(frame).not.toContain("write_file(");
      expect(frame).not.toContain("! Approve");
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
      setup.mockInput.pressKey("h");
      await flush(setup);

      expect(submitted).toEqual([]);
      expect(answers).toEqual(["no"]);
    });

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

      setup.mockInput.pressKey("y");
      await flush(setup);
      expect(answers).toEqual(["once"]);
    });
  });

  // captureCharFrame carries no attribute/color info, so this is the one place that pins selectedFg on selectedBg.
  describe("ListRow", () => {
    // OpenTUI 0.5.6 renders INVERSE as a background equal to the cell's foreground, which made selected text invisible.
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
    test("a splash mount's first frame is the welcome splash, not session chrome", async () => {
      const { setup } = await connect({
        showSplash: true,
        authOffer: true,
        onSubmit: undefined,
        splashBanner: {
          version: "0.4.2",
          model: "openai/gpt-oss-120b",
          provider: "groq",
          via: "groq",
          cwd: "/home/lion/code/seri",
          home: "/home/lion",
        },
      });

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Log in");
      expect(frame).toContain("Sign up");
      expect(frame).toContain("Continue without logging in");
      expect(frame).not.toContain("starting session");
      expect(frame).not.toContain("approve-each mode on");
    });

    // OpenTUI truncate clips with a middle ellipsis ("Continue...ogging in" at width 24), so the narrow half checks the middle of the label is gone.
    test("rows carry the ListRow marker, and truncate rather than wrap at a narrow width", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "splash-requested" });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("> Log in");

      await resize(setup, 24, DEFAULT_HEIGHT);

      const narrowFrame = setup.captureCharFrame();
      // "Continu", not "Continue": one-column left/right padding costs two columns, and at width 24 the middle ellipsis eats one more head character.
      expect(narrowFrame).toContain("Continu");
      expect(narrowFrame).not.toContain("without");
    });

    test("the banner names the product, version, model and directory", async () => {
      const { setup, dispatch } = await connect({
        splashBanner: {
          version: "0.4.2",
          model: "openai/gpt-oss-120b",
          provider: "groq",
          via: "groq",
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

    test("the banner holds the top of the transcript on a live session", async () => {
      const { setup, dispatch } = await connect({
        splashBanner: {
          version: "0.4.2",
          model: "openai/gpt-oss-120b",
          provider: "groq",
          via: "groq",
          cwd: "/home/lion/code/seri",
          home: "/home/lion",
        },
        route: route({ model: "openai/gpt-oss-120b", provider: "groq" }),
      });

      dispatch({ type: "transcript-append", role: "system", line: "Session s1 created." });
      await flush(setup);

      const lines = setup.captureCharFrame().split("\n");
      const bannerIndex = lines.findIndex((l) => l.includes("seri v0.4.2"));
      const createdIndex = lines.findIndex((l) => l.includes("Session s1 created."));
      expect(bannerIndex).toBeGreaterThanOrEqual(0);
      expect(lines[bannerIndex]).toContain("~/code/seri");
      expect(lines[bannerIndex]).toContain("openai/gpt-oss-120b · groq");
      expect(bannerIndex).toBeLessThan(createdIndex);
    });

    test("the session banner reflects a route-updated dispatch without remounting", async () => {
      const { setup, dispatch } = await connect({
        splashBanner: {
          version: "0.4.2",
          model: "openai/gpt-oss-120b",
          provider: "openrouter",
          via: "openrouter",
          cwd: "/home/lion/code/seri",
          home: "/home/lion",
        },
        route: route({ model: "openai/gpt-oss-120b", provider: "openrouter" }),
      });

      const bannerBefore = setup
        .captureCharFrame()
        .split("\n")
        .find((l) => l.includes("seri v0.4.2"));
      expect(bannerBefore).toContain("openai/gpt-oss-120b · openrouter");

      dispatch({
        type: "route-updated",
        route: route({ model: "minimax/minimax-m3:free", provider: "openrouter" }),
      });
      await flush(setup);

      const bannerAfter = setup
        .captureCharFrame()
        .split("\n")
        .find((l) => l.includes("seri v0.4.2"));
      expect(bannerAfter).toContain("minimax/minimax-m3:free · openrouter");
      expect(bannerAfter).not.toContain("openai/gpt-oss-120b");
    });

    test("the session banner updates immediately from a /model pick", async () => {
      const { setup, dispatch } = await connect({
        splashBanner: {
          version: "0.4.2",
          model: "openai/gpt-oss-120b",
          provider: "openrouter",
          via: "openrouter",
          cwd: "/home/lion/code/seri",
          home: "/home/lion",
        },
        route: route({ model: "openai/gpt-oss-120b", provider: "openrouter" }),
      });

      dispatch({
        type: "model-picker-resolved",
        pick: { model: "minimax/minimax-m3:free", provider: "openrouter", keyConfigured: true },
      });
      await flush(setup);

      const banner = setup
        .captureCharFrame()
        .split("\n")
        .find((l) => l.includes("seri v0.4.2"));
      expect(banner).toContain("minimax/minimax-m3:free · openrouter");
      expect(banner).not.toContain("openai/gpt-oss-120b");
    });

    test("a seri-plan /model pick updates the banner and mode row before any turn", async () => {
      const { setup, dispatch } = await connect({
        splashBanner: {
          version: "0.4.2",
          model: "openai/gpt-oss-120b",
          provider: "openrouter",
          via: "openrouter",
          cwd: "/home/lion/code/seri",
          home: "/home/lion",
        },
        route: route({
          model: "openai/gpt-oss-120b",
          provider: "openrouter",
          credential: "gateway",
        }),
      });

      dispatch({
        type: "model-picker-resolved",
        pick: { model: "minimax/minimax-m3:free", provider: "openrouter", keyConfigured: false },
        route: route({
          model: "minimax/minimax-m3:free",
          provider: "openrouter",
          credential: "gateway",
        }),
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      const banner = frame.split("\n").find((l) => l.includes("seri v0.4.2"));
      const mode = frame.split("\n").find((l) => l.includes(MODE_LABEL["approve-each"]));
      expect(banner).toContain("minimax/minimax-m3:free · seri");
      expect(banner).not.toContain("openai/gpt-oss-120b");
      expect(banner).not.toContain("openrouter");
      expect(mode).toContain("minimax/minimax-m3:fr");
      expect(mode).toContain("seri");
      expect(mode).not.toContain("openai/gpt-oss-120b");
    });

    test("a hosted session banner names seri, never the gateway listing", async () => {
      const { setup } = await connect({
        splashBanner: {
          version: "0.4.2",
          model: "minimax/minimax-m3:free",
          provider: "openrouter",
          via: "seri",
          cwd: "/home/lion/code/seri",
          home: "/home/lion",
        },
        route: route({
          model: "minimax/minimax-m3:free",
          provider: "openrouter",
          credential: "gateway",
        }),
      });

      const banner = setup
        .captureCharFrame()
        .split("\n")
        .find((l) => l.includes("seri v0.4.2"));
      expect(banner).toContain("minimax/minimax-m3:free · seri");
      expect(banner).not.toContain("openrouter");
    });

    test("a hosted splash banner names seri even before a route exists", async () => {
      const { setup, dispatch } = await connect({
        splashBanner: {
          version: "0.4.2",
          model: "minimax/minimax-m3:free",
          provider: "openrouter",
          via: "seri",
          cwd: "/home/lion/code/seri",
          home: "/home/lion",
        },
      });

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "splash-requested" });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("minimax/minimax-m3:free · seri");
      expect(frame).not.toContain("openrouter");
    });

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

    test("a mount with no pre-session handler keeps the inert placeholder", async () => {
      const { setup } = await connect({ onSubmit: undefined });

      setup.mockInput.typeText("dropped");
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("starting session");
      expect(frame).not.toContain("dropped");
    });

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
        subscriptionCovered: false,
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

      expect(setup.captureCharFrame()).toContain(
        'Type to filter — try "included", "free" or "paid"…',
      );

      await setup.mockInput.typeText("8b");
      await flush(setup);

      expect(setup.captureCharFrame()).not.toContain(
        'Type to filter — try "included", "free" or "paid"…',
      );
    });

    // With an empty filter the row is "> " + caret + placeholder; Yoga flexShrink used to drop promptText's trailing space once width ran out.
    test("keeps the cursor's own column visible at a narrow width with an empty filter", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "model-picker-requested", entries: [row()] });
      await flush(setup);

      await resize(setup, 42, DEFAULT_HEIGHT);

      expect(setup.captureCharFrame()).toContain(">  Type to filter");
    });

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
      // OpenTUI holds a bare ESC for a disambiguation window longer than flush()'s macrotask tick.
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

    // Without flexBasis={0}/overflow="hidden" on the transcript wrap, a same-frame sibling panel keeps the scrollbox's stale height and transcript glyphs bleed into its rows.
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
      expect(frame).toContain("> Model 15");

      setup.mockInput.pressEnter();
      await flush(setup);

      expect(selected).toEqual([{ model: "model-15", provider: "groq", keyConfigured: true }]);
    });
  });

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
      // OpenTUI holds a bare ESC for a disambiguation window longer than flush()'s macrotask tick.
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
          kind: "key",
          provider: "groq",
          keyName: "GROQ_API_KEY",
          source: "unset",
          masked: undefined,
          removable: false,
        },
        {
          kind: "key",
          provider: "openrouter",
          keyName: "OPENROUTER_API_KEY",
          source: "config",
          masked: "sk-o...abcd",
          removable: true,
        },
        {
          kind: "key",
          provider: "anthropic",
          keyName: "ANTHROPIC_API_KEY",
          source: "env",
          masked: "sk-a...wxyz",
          removable: false,
        },
        {
          kind: "key",
          provider: "openai",
          keyName: "OPENAI_API_KEY",
          source: "unset",
          masked: undefined,
          removable: false,
        },
        {
          kind: "key",
          provider: "google",
          keyName: "GOOGLE_GENERATIVE_AI_API_KEY",
          source: "unset",
          masked: undefined,
          removable: false,
        },
      ];
    }

    describe("formatSetupRow", () => {
      function row(overrides: Partial<SetupKeyRow> = {}): SetupKeyRow {
        return {
          kind: "key",
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

      test("seri subscription names the plan type", () => {
        expect(
          formatSetupRow({
            kind: "subscription",
            provider: "seri",
            status: { status: "connected", planType: "pro" },
          }),
        ).toContain("connected — pro");
        expect(
          formatSetupRow({
            kind: "subscription",
            provider: "seri",
            status: { status: "ignored" },
          }),
        ).toContain("ignored — using your keys");
      });

      test("a leftover OpenRouter key under a seri plan is marked unused", () => {
        const text = formatSetupRow(
          row({
            provider: "openrouter",
            source: "config",
            masked: "sk-o...own1",
            removable: true,
            unusedBecause: "unused because a seri plan is connected",
          }),
        );
        expect(text).toContain("sk-o...own1");
        expect(text).toContain("unused because a seri plan is connected");
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

      test("env, removable: says a config.json entry underneath is removable, not that removal is disabled", () => {
        const text = formatSetupRow(row({ source: "env", masked: "sk-a...wxyz", removable: true }));
        expect(text).not.toContain("unset it in your shell");
        expect(text).toContain("removable");
        expect(text).toContain("sk-a...wxyz");
      });

      test("subscription: grok connected / not connected", () => {
        expect(
          formatSetupRow({ kind: "subscription", provider: "xai", connected: false }),
        ).toContain("not connected");
        expect(
          formatSetupRow({ kind: "subscription", provider: "xai", connected: true }),
        ).toContain("connected");
      });

      test("xai key unused because a subscription is connected", () => {
        const text = formatSetupRow(
          row({
            provider: "xai",
            keyName: "XAI_API_KEY",
            source: "config",
            masked: "xai-...key1",
            unusedBecause: "unused because a Grok subscription is connected",
          }),
        );
        expect(text).toContain("unused");
        expect(text).toContain("Grok subscription is connected");
      });

      test("a Codex subscription row names chatgpt, not an API key", () => {
        const text = formatSetupRow({
          kind: "subscription",
          provider: "openai",
          status: { status: "connected" },
          removable: true,
        });
        expect(text).toContain("chatgpt");
        expect(text).toContain("connected");
        expect(text).not.toContain("codex");
        expect(text).not.toContain("openai");
      });

      test("an ignored Codex row names the ignore, not connected", () => {
        const text = formatSetupRow({
          kind: "subscription",
          provider: "openai",
          status: { status: "ignored" },
          removable: false,
        });
        expect(text).toContain("chatgpt");
        expect(text).toContain("ignored");
        expect(text).not.toContain("connected");
      });

      test("a Codex connected row surfaces planType when known", () => {
        const text = formatSetupRow({
          kind: "subscription",
          provider: "openai",
          status: { status: "connected", planType: "free" },
          removable: true,
        });
        expect(text).toContain("chatgpt");
        expect(text).toContain("connected — free");
      });

      test("an unused openai key names the ChatGPT plan as the reason", () => {
        const text = formatSetupRow(
          row({
            provider: "openai",
            keyName: "OPENAI_API_KEY",
            source: "config",
            masked: "sk-o...abcd",
            unusedBecause: "unused because a ChatGPT plan is connected",
          }),
        );
        expect(text).toContain("unused because a ChatGPT plan is connected");
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
      expect(frame).toContain("set by $ANTHROPIC_API_KEY in your environment");
      expect(frame).toContain(`> ${formatSetupRow(setupRows()[0] as SetupProviderRow)}`);
    });

    test("the list step: Enter (not the 'a' shortcut) selects the highlighted row via onSetupSelect", async () => {
      const selected: SetupProviderRow[] = [];
      const { setup, dispatch } = await connect({
        onSetupSelect: (row) => selected.push(row),
      });

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush(setup);

      // One Down reaches openrouter (index 1) — CATALOG_PROVIDERS order matches setupRows() above.
      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);

      expect(selected).toHaveLength(1);
      expect(selected[0]).toMatchObject({ kind: "key", provider: "openrouter" });
    });

    // OpenTUI Delete is \x1b[3~, a different sequence from backspace.
    test("the list step: Delete (not the 'r' shortcut) requests removal via onSetupRemove, when the row is removable", async () => {
      const removeRequested: SetupProviderRow[] = [];
      const { setup, dispatch } = await connect({
        onSetupRemove: (row) => removeRequested.push(row),
      });

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush(setup);

      // openrouter (index 1) is the removable row in setupRows() above.
      setup.mockInput.pressArrow("down");
      await flush(setup);
      setup.mockInput.pressKey(DELETE_KEY);
      await flush(setup);

      expect(removeRequested).toHaveLength(1);
      expect(removeRequested[0]).toMatchObject({ kind: "key", provider: "openrouter" });
    });

    test("the list step: Delete on a non-removable row calls neither onSetupSelect nor onSetupRemove", async () => {
      const selected: SetupProviderRow[] = [];
      const removeRequested: SetupProviderRow[] = [];
      const { setup, dispatch } = await connect({
        onSetupSelect: (row) => selected.push(row),
        onSetupRemove: (row) => removeRequested.push(row),
      });

      // groq (index 0, the default selection) is source: "unset", removable: false.
      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush(setup);

      setup.mockInput.pressKey(DELETE_KEY);
      await flush(setup);

      expect(selected).toEqual([]);
      expect(removeRequested).toEqual([]);
    });

    test("a connected seri row offers disconnect and ignores r on a non-removable key", async () => {
      const selected: SetupProviderRow[] = [];
      const removeRequested: SetupProviderRow[] = [];
      const { setup, dispatch } = await connect({
        onSetupSelect: (row) => selected.push(row),
        onSetupRemove: (row) => removeRequested.push(row),
      });

      dispatch({
        type: "setup-requested",
        rows: [
          {
            kind: "subscription",
            provider: "seri",
            status: { status: "connected", planType: "max" },
          },
        ],
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("connected — max");
      expect(frame).toContain("Enter/r disconnect");

      setup.mockInput.pressKey("r");
      await flush(setup);
      expect(selected).toHaveLength(1);
      expect(selected[0]).toMatchObject({ kind: "subscription", provider: "seri" });
      expect(removeRequested).toEqual([]);
    });

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

    test("the enter-key step shows a note when one is on the step", async () => {
      const { setup, dispatch } = await connect();

      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider: "openrouter",
          keyName: "OPENROUTER_API_KEY",
          busy: false,
          note: "Unused while a seri plan is connected.",
        },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("OPENROUTER_API_KEY for openrouter");
      expect(frame).toContain("Unused while a seri plan is connected.");
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
      const removed: SetupProviderRow[] = [];
      const backCalls: number[] = [];
      const { setup, dispatch } = await connect({
        onSetupRemove: (row) => removed.push(row),
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
      expect(setup.captureCharFrame()).toContain("Remove OPENROUTER_API_KEY");
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

      expect(removed).toHaveLength(1);
      expect(removed[0]).toMatchObject({ kind: "key", provider: "openrouter" });
    });

    test("confirm-remove: an arrow key is a no-op, not an implicit cancel", async () => {
      const removed: SetupProviderRow[] = [];
      const backCalls: number[] = [];
      const { setup, dispatch } = await connect({
        onSetupRemove: (row) => removed.push(row),
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

      setup.mockInput.pressKey("y");
      await flush(setup);
      expect(removed).toHaveLength(1);
      expect(removed[0]).toMatchObject({ kind: "key", provider: "openrouter" });
    });

    test("confirm-connect shows the borrowed-client warning before any connect action", async () => {
      const confirmed: SetupProviderRow[] = [];
      const backCalls: number[] = [];
      const { setup, dispatch } = await connect({
        onSetupRemove: (row) => confirmed.push(row),
        onSetupBack: () => backCalls.push(backCalls.length),
      });

      dispatch({ type: "setup-step", state: { step: "confirm-connect", provider: "xai" } });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Grok Build's OAuth client id");
      expect(frame).toContain("Shown before the browser opens");
      expect(GROK_BORROWED_CLIENT_WARNING).toContain("Grok Build's OAuth client id");
      expect(confirmed).toEqual([]);

      setup.mockInput.pressKey("n");
      await flush(setup);
      expect(confirmed).toEqual([]);
      expect(backCalls).toEqual([0]);
    });

    test("confirm-connect: 'y' confirms via onSetupRemove, Enter cancels", async () => {
      const confirmed: SetupProviderRow[] = [];
      const backCalls: number[] = [];
      const { setup, dispatch } = await connect({
        onSetupRemove: (row) => confirmed.push(row),
        onSetupBack: () => backCalls.push(backCalls.length),
      });

      dispatch({ type: "setup-step", state: { step: "confirm-connect", provider: "xai" } });
      await flush(setup);
      setup.mockInput.pressEnter();
      await flush(setup);
      expect(confirmed).toEqual([]);
      expect(backCalls).toEqual([0]);

      dispatch({ type: "setup-step", state: { step: "confirm-connect", provider: "xai" } });
      await flush(setup);
      setup.mockInput.pressKey("y");
      await flush(setup);
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]).toMatchObject({ kind: "subscription", provider: "xai" });
    });

    test("confirm-disconnect for Codex names the local ignore, not Grok's client id", async () => {
      const confirmed: SetupProviderRow[] = [];
      const { setup, dispatch } = await connect({
        onSetupRemove: (row) => confirmed.push(row),
      });

      dispatch({ type: "setup-step", state: { step: "confirm-disconnect", provider: "openai" } });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("local credential only");
      expect(frame).toContain("~/.codex/auth.json is not touched");
      expect(frame).not.toContain("Grok Build");

      setup.mockInput.pressKey("y");
      await flush(setup);
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]).toMatchObject({ kind: "subscription", provider: "openai" });
    });

    test("confirm-connect for Codex connect shows the borrowed-client warning", async () => {
      const confirmed: SetupProviderRow[] = [];
      const { setup, dispatch } = await connect({
        onSetupRemove: (row) => confirmed.push(row),
      });

      dispatch({
        type: "setup-step",
        state: { step: "confirm-connect", provider: "openai", action: "connect" },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Codex CLI's OAuth client id");
      expect(frame).toContain("Shown before the browser opens");
      expect(frame).not.toContain("Grok Build's OAuth client id");

      setup.mockInput.pressKey("y");
      await flush(setup);
      expect(confirmed[0]).toMatchObject({
        kind: "subscription",
        provider: "openai",
        status: { status: "not-connected" },
      });
    });

    test("confirm-connect for Codex re-enables without the Grok warning", async () => {
      const confirmed: SetupProviderRow[] = [];
      const { setup, dispatch } = await connect({
        onSetupRemove: (row) => confirmed.push(row),
      });

      dispatch({ type: "setup-step", state: { step: "confirm-connect", provider: "openai" } });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Re-enable ChatGPT plan");
      expect(frame).toContain("local ignore");
      expect(frame).not.toContain("Grok Build's OAuth client id");

      setup.mockInput.pressKey("y");
      await flush(setup);
      expect(confirmed[0]).toMatchObject({
        kind: "subscription",
        provider: "openai",
        status: { status: "ignored" },
      });
    });

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
        subscriptionCovered: false,
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

    test("formatModelRow includes name, context, cost and route, in that order", () => {
      const row = formatModelRow(pickerRow());
      const nameIndex = row.indexOf("Llama 3.3 70B");
      const contextIndex = row.indexOf("128K");
      const costIndex = row.indexOf("$0.59/$0.79");
      const routeIndex = row.indexOf("groq");
      expect(nameIndex).toBeGreaterThanOrEqual(0);
      expect(contextIndex).toBeGreaterThan(nameIndex);
      expect(costIndex).toBeGreaterThan(contextIndex);
      expect(routeIndex).toBeGreaterThan(costIndex);
      expect(row).not.toContain("your key");
    });

    test("formatModelRow renders the provider as Route for a keyed row, or 'no key', and a '+N route(s)' suffix only when alternatives > 0", () => {
      const configured = formatModelRow(pickerRow({ keyConfigured: true, alternatives: 0 }));
      expect(configured).toContain("groq");
      expect(configured).not.toContain("your key");
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

    test("formatModelRow names the reroute target on a keyless row that has one", () => {
      const rerouted = formatModelRow(
        pickerRow({ keyConfigured: false, alternatives: 1, rerouteTo: "anthropic" }),
      );
      expect(rerouted).toContain("→ anthropic");
      expect(rerouted).not.toContain("no key");
      expect(rerouted).not.toContain("route");
    });

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

    test("formatModelRow unbounded with +1 route is longer than the four columns and still carries cost", () => {
      const row = formatModelRow(
        pickerRow({
          alternatives: 1,
          entry: entry({
            pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
            contextWindow: 131_072,
          }),
        }),
      );
      expect(row.length).toBeGreaterThan(63);
      expect(row).toContain("+1 route");
      expect(row).toContain("$0.15/$0.60");
    });

    test("pickerLabelWidth at 80 is 74, and 0 falls back the same as 80", () => {
      expect(pickerLabelWidth(80)).toBe(74);
      expect(pickerLabelWidth(0)).toBe(pickerLabelWidth(80));
    });

    test("formatModelRow at pickerLabelWidth(80) keeps Context, Cost, Route and the +1 route suffix", () => {
      const priced = pickerRow({
        alternatives: 1,
        entry: entry({
          pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
          contextWindow: 131_072,
        }),
      });
      const row = formatModelRow(priced, pickerLabelWidth(80));
      expect(row).toContain("128K");
      expect(row).toContain("$0.15/$0.60");
      expect(row).toContain("+1 route");
      expect(row.length).toBeLessThanOrEqual(74);
    });

    test("formatModelRow at pickerLabelWidth(70) drops the suffix but keeps Route", () => {
      const priced = pickerRow({
        alternatives: 1,
        entry: entry({
          pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
          contextWindow: 131_072,
        }),
      });
      const row = formatModelRow(priced, pickerLabelWidth(70));
      expect(row).toContain("128K");
      expect(row).toContain("$0.15/$0.60");
      expect(row).not.toContain("+1 route");
    });

    test("formatModelRow at pickerLabelWidth(100) keeps the +1 route suffix", () => {
      const priced = pickerRow({
        alternatives: 1,
        entry: entry({
          pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
          contextWindow: 131_072,
        }),
      });
      expect(formatModelRow(priced, pickerLabelWidth(100))).toContain("+1 route");
      expect(formatModelRow(priced)).toContain("+1 route");
    });

    test("formatModelPickerHeader at pickerLabelWidth(80) still contains Route", () => {
      expect(formatModelPickerHeader(pickerLabelWidth(80))).toContain("Route");
    });

    test("formatModelPickerHeader at pickerLabelWidth(60) drops Route; the row keeps Context and Cost", () => {
      expect(formatModelPickerHeader(pickerLabelWidth(60))).not.toContain("Route");
      const priced = pickerRow({
        alternatives: 1,
        entry: entry({
          pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
          contextWindow: 131_072,
        }),
      });
      const row = formatModelRow(priced, pickerLabelWidth(60));
      expect(row).toContain("128K");
      expect(row).toContain("$0.15/$0.60");
      expect(row).not.toContain("your key");
    });

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

    test("a subscription-covered row costs 'included' and names the plan source", () => {
      const row = pickerRow({
        keyConfigured: false,
        subscriptionCovered: true,
        entry: entry({ provider: "openai", pricing: undefined }),
      });
      const rendered = formatModelRow(row);
      expect(rendered).toContain("included");
      expect(rendered).toContain("chatgpt");
      expect(rendered).not.toContain("codex");
      expect(rendered).not.toContain("no key");
      expect(rendered).not.toContain("$");
      expect(
        formatRouteLabel({
          keyConfigured: false,
          subscriptionCovered: true,
          provider: "openai",
        }),
      ).toBe("chatgpt");
    });

    test("subscriptionCovered beats keyConfigured in the Route column", () => {
      expect(
        formatRouteLabel({
          keyConfigured: true,
          subscriptionCovered: true,
          provider: "xai",
        }),
      ).toBe("grok");
    });

    test("matchesFilter matches a subscription-covered row with 'included' and 'plan', not 'free'", () => {
      const covered = pickerRow({
        subscriptionCovered: true,
        entry: entry({ provider: "openai", pricing: undefined }),
      });
      expect(matchesFilter(covered, "included")).toBe(true);
      expect(matchesFilter(covered, "plan")).toBe(true);
      expect(matchesFilter(covered, "chatgpt")).toBe(true);
      expect(matchesFilter(covered, "free")).toBe(false);
      const leftover = pickerRow({
        subscriptionCovered: false,
        entry: entry({
          id: "gpt-5.6",
          displayName: "GPT-5.6",
          provider: "openai",
          family: "gpt",
          pricing: { inputPerMTok: 4, outputPerMTok: 20 },
        }),
      });
      expect(matchesFilter(leftover, "chatgpt")).toBe(false);
      const zeroPrice = pickerRow({
        subscriptionCovered: false,
        entry: entry({
          id: "stealth/ox-alpha",
          displayName: "Ox Alpha",
          pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        }),
      });
      expect(matchesFilter(zeroPrice, "included")).toBe(false);
      expect(matchesFilter(zeroPrice, "free")).toBe(true);
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

  describe("formatRouteLabel", () => {
    test("keyConfigured names the provider, not 'your key'", () => {
      expect(
        formatRouteLabel({ keyConfigured: true, provider: "anthropic", rerouteTo: "openrouter" }),
      ).toBe("anthropic");
      expect(formatRouteLabel({ keyConfigured: true, rerouteTo: "openrouter" })).toBe("your key");
    });

    test("a keyless row with a reroute target: '→ <provider>'", () => {
      expect(formatRouteLabel({ keyConfigured: false, rerouteTo: "openrouter" })).toBe(
        "→ openrouter",
      );
    });

    test("a keyless, no-reroute row with gatewayReachable: 'seri'", () => {
      expect(formatRouteLabel({ keyConfigured: false, gatewayReachable: true })).toBe("seri");
    });

    test("subscriptionCovered names the vendor; omitted provider stays 'plan'", () => {
      expect(
        formatRouteLabel({
          keyConfigured: true,
          subscriptionCovered: true,
          provider: "openai",
        }),
      ).toBe("chatgpt");
      expect(formatRouteLabel({ keyConfigured: false, subscriptionCovered: true })).toBe("plan");
    });

    test("a leftover gateway listing key under coverage still reads 'seri'", () => {
      expect(
        formatRouteLabel({
          keyConfigured: true,
          gatewayReachable: true,
          provider: "openrouter",
        }),
      ).toBe("seri");
    });

    test("the true dead end — no key, no reroute, no gateway: 'no key'", () => {
      expect(formatRouteLabel({ keyConfigured: false, gatewayReachable: false })).toBe("no key");
    });
  });

  describe("slideWindow", () => {
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

    // An unsanitized config value can carry a raw ESC onto the real terminal under the alt screen; escapeControlChars must show \xNN, not strip.
    test("escapes a raw ESC byte instead of passing it through to the real terminal", () => {
      expect(singleLine("before\x1b[31mafter")).toBe("before\\x1b[31mafter");
    });
  });

  test("a live input has no full-width hairline above the box", async () => {
    const { setup } = await connect();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("─".repeat(DEFAULT_WIDTH));
    expect(frame).toContain("describe a task");
  });

  describe("listWindowSize", () => {
    test("APP_CHROME_ROWS is one row each for mode and commandError", () => {
      expect(APP_CHROME_ROWS).toBe(2);
    });

    test("a tall terminal clamps to LIST_WINDOW_MAX (10)", () => {
      expect(listWindowSize(24)).toBe(10);
    });

    test("a short terminal clamps to MIN_LIST_WINDOW (3), never fewer", () => {
      expect(listWindowSize(5)).toBe(3);
    });

    test("a terminal in between returns rows minus the panel chrome budget", () => {
      expect(listWindowSize(18)).toBe(10);
      expect(listWindowSize(15)).toBe(7);
    });
  });

  describe("persistent mode+route indicator (mounted)", () => {
    test("renders the model+route label at the default width, and drops it after a resize too narrow for the model", async () => {
      const { setup } = await connect();
      expect(setup.captureCharFrame()).toContain("anthropic");

      // 30: approve-each (22) + "  claude-sonnet-5" (17) = 39, which cannot fit; 40 would show the model.
      await resize(setup, 30, DEFAULT_HEIGHT);

      expect(setup.captureCharFrame()).not.toContain("claude-sonnet-5");
    });

    test("mounts with route undefined and shows no fabricated route text", async () => {
      const { setup } = await connect({ route: undefined });
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("your key");
      expect(frame).not.toContain("→");
    });

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

    test("a /model pick with no configured key leaves the status bar on the old route, not a fabricated one", async () => {
      const { setup, dispatch } = await connect();
      expect(setup.captureCharFrame()).toContain("claude-sonnet-5");
      expect(setup.captureCharFrame()).toContain("anthropic");

      dispatch({
        type: "model-picker-resolved",
        pick: { model: "some-unconfigured-model", provider: "openrouter", keyConfigured: false },
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("claude-sonnet-5");
      expect(frame).not.toContain("some-unconfigured-model");
    });

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

      expect(modeRow(setup)).toContain("claude-sonnet-5 · anthropic · high");
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
      expect(modeRow(setup)).toContain("claude-sonnet-5 · anthropic");
    });

    test("a stale tier on a model with no reasoningOptions does not render, from either source", async () => {
      const { setup, dispatch } = await connect({
        catalog: catalogOf([catalogEntry({ reasoningOptions: undefined })]),
      });

      dispatch({ type: "effort-resolved", tier: "high" });
      await flush(setup);

      expect(modeRow(setup)).not.toContain("· high");
      expect(modeRow(setup)).toContain("claude-sonnet-5 · anthropic");

      dispatch({ type: "session-updated", session: session({ reasoningEffort: undefined }) });
      await flush(setup);
      dispatch({ type: "config-updated", config: { SERI_REASONING_EFFORT: "high" } });
      await flush(setup);

      expect(modeRow(setup)).not.toContain("· high");
      expect(modeRow(setup)).toContain("claude-sonnet-5 · anthropic");
    });

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

      expect(modeRow(setup)).toContain("claude-sonnet-5 · anthropic · high");
    });

    test("mounting with a config default already renders the tier, with no dispatch at all", async () => {
      const { setup } = await connect({
        catalog: catalogOf([
          catalogEntry({
            reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
          }),
        ]),
        config: { SERI_REASONING_EFFORT: "high" },
      });

      expect(modeRow(setup)).toContain("claude-sonnet-5 · anthropic · high");
    });

    test("no session override and no config default: the mode row shows no tier", async () => {
      const { setup } = await connect({
        catalog: catalogOf([
          catalogEntry({
            reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
          }),
        ]),
      });

      expect(modeRow(setup)).not.toContain("· high");
      expect(modeRow(setup)).toContain("claude-sonnet-5 · anthropic");
    });

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

      expect(modeRow(setup)).toContain("claude-sonnet-5 · anthropic · high");
      expect(modeRow(setup)).not.toContain("· low");
    });

    test("mounting with no catalog prop is safe: no crash, and no tier renders", async () => {
      const { setup, dispatch } = await connect({ catalog: undefined });

      dispatch({ type: "effort-resolved", tier: "high" });
      await flush(setup);

      expect(modeRow(setup)).not.toContain("· high");
      expect(modeRow(setup)).toContain("claude-sonnet-5 · anthropic");
    });
  });

  describe("mode row color and hint", () => {
    // theme.mode mixes hex and ANSI-16 "gray"; RGBA.fromHex("gray") silently becomes magenta, and approve-each merges with theme.muted into one span.
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

    test("the model name stays theme.muted, not the mode hue, even in auto", async () => {
      const { setup } = await connect({ session: session({ permissionMode: "auto" }) });
      const frame = setup.captureSpans();
      const line = frame.lines.find((l) => l.spans.some((s) => s.text.includes("claude-sonnet-5")));
      const span = line?.spans.find((s) => s.text.includes("claude-sonnet-5"));
      expect(span?.fg.equals(parseColor(theme.muted))).toBe(true);
      expect(span?.fg.equals(parseColor(theme.mode.auto))).toBe(false);
    });

    test("the shift+tab hint is present at MODE_HINT_COLS and absent below it", async () => {
      // Empty detail so this asserts the 52-col floor itself, not leftover packing.
      const { setup } = await connect({ route: undefined });
      expect(setup.captureCharFrame()).toContain("(shift+tab to cycle)");

      await resize(setup, MODE_HINT_COLS, DEFAULT_HEIGHT);
      expect(setup.captureCharFrame()).toContain("(shift+tab to cycle)");

      await resize(setup, MODE_HINT_COLS - 1, DEFAULT_HEIGHT);
      expect(setup.captureCharFrame()).not.toContain("(shift+tab to cycle)");
    });

    test("at MODE_HINT_COLS with confinement, leftover-packed sandbox stays and the hint yields", async () => {
      const original = process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
      delete process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
      try {
        const { setup } = await connect({ confinementAvailable: true, route: undefined });
        await resize(setup, MODE_HINT_COLS, DEFAULT_HEIGHT);
        const frame = setup.captureCharFrame();
        expect(frame).toContain(" · unsandboxed");
        expect(frame).not.toContain("(shift+tab to cycle)");
      } finally {
        if (original === undefined) delete process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
        else process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS = original;
      }
    });

    test("sandbox suffix and cycle hint both fit once remaining covers label + suffix + hint", async () => {
      const original = process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
      delete process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
      try {
        const { setup } = await connect({
          confinementAvailable: true,
          route: undefined,
          session: session({ permissionMode: "auto" }),
        });
        const bothFit = MODE_LABEL.auto.length + " · unsandboxed".length + MODE_CYCLE_HINT.length;
        await resize(setup, bothFit, DEFAULT_HEIGHT);
        const frame = setup.captureCharFrame();
        expect(frame).toContain(" · unsandboxed");
        expect(frame).toContain("(shift+tab to cycle)");
      } finally {
        if (original === undefined) delete process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
        else process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS = original;
      }
    });

    test("sandbox suffix drops when leftover after the mode label is shorter than the suffix", async () => {
      const original = process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
      delete process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
      try {
        const { setup } = await connect({
          confinementAvailable: true,
          route: undefined,
          session: session({ permissionMode: "auto" }),
        });
        const suffix = " · unsandboxed";
        const tooNarrow = MODE_LABEL.auto.length + suffix.length - 1;
        await resize(setup, tooNarrow, DEFAULT_HEIGHT);
        const frame = setup.captureCharFrame();
        expect(frame).toContain(MODE_LABEL.auto);
        expect(frame).not.toContain("unsandboxed");
        const modeLine = frame.split("\n").find((l) => l.includes(MODE_LABEL.auto));
        expect(modeLine?.trimEnd().length).toBeLessThanOrEqual(tooNarrow);
      } finally {
        if (original === undefined) delete process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
        else process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS = original;
      }
    });

    test("the mode row does not claim an OS sandbox when confinement was not passed in", async () => {
      const { setup } = await connect();
      expect(setup.captureCharFrame()).not.toContain("os sandbox");
      expect(setup.captureCharFrame()).not.toContain("unsandboxed");
    });

    test("the mode row names unsandboxed when bang may leave a real OS sandbox", async () => {
      const original = process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
      delete process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
      try {
        const { setup } = await connect({ confinementAvailable: true });
        expect(setup.captureCharFrame()).toContain(" · unsandboxed");
      } finally {
        if (original === undefined) delete process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
        else process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS = original;
      }
    });

    test("the mode row names os sandbox when the strict floor is on and confinement exists", async () => {
      const original = process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
      process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS = "false";
      try {
        const { setup } = await connect({
          confinementAvailable: true,
          config: { SERI_ALLOW_UNSANDBOXED_COMMANDS: "false" },
        });
        expect(setup.captureCharFrame()).toContain(" · os sandbox");
        expect(setup.captureCharFrame()).not.toContain("unsandboxed");
      } finally {
        if (original === undefined) delete process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS;
        else process.env.SERI_ALLOW_UNSANDBOXED_COMMANDS = original;
      }
    });

    test("at 80 columns, the idle mode row keeps the route suffix without wrapping", async () => {
      const { setup } = await connect({
        session: session({ permissionMode: "approve-each" }),
        route: route(),
      });
      await resize(setup, DEFAULT_COLUMNS, DEFAULT_HEIGHT);

      const lines = setup.captureCharFrame().split("\n");
      const modeLine = lines.find((l) => l.includes(MODE_LABEL["approve-each"]));
      expect(modeLine).toBeDefined();
      expect(modeLine).toContain("anthropic");
      expect(modeLine).toContain("(shift+tab to cycle)");
      expect(modeLine?.trimEnd().length).toBeLessThanOrEqual(DEFAULT_COLUMNS);
    });

    test("at 80 columns, a worst-case left side drops the hint before the route", async () => {
      const longModel = "n".repeat(NAME_WIDTH);
      const { setup } = await connect({
        session: session({ permissionMode: "auto", reasoningEffort: "high" }),
        route: route({
          model: longModel,
          provider: "openrouter",
          rerouted: true,
          reason: "ANTHROPIC_API_KEY",
        }),
        catalog: catalogOf([
          catalogEntry({
            id: longModel,
            provider: "openrouter",
            reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
          }),
        ]),
      });
      await resize(setup, DEFAULT_COLUMNS, DEFAULT_HEIGHT);

      const lines = setup.captureCharFrame().split("\n");
      const modeLine = lines.find((l) => l.includes(MODE_LABEL.auto));
      expect(modeLine).toBeDefined();
      expect(modeLine).toContain("→ openrouter");
      expect(modeLine).not.toContain("(shift+tab to cycle)");
      expect(modeLine).toContain("high");
      expect(modeLine?.trimEnd().length).toBeLessThanOrEqual(DEFAULT_COLUMNS);
    });

    test("at 80 columns, the longest label with a route present fits the row and does not wrap", async () => {
      const { setup } = await connect({
        session: session({ permissionMode: "auto" }),
        route: route(),
      });
      await resize(setup, DEFAULT_COLUMNS, DEFAULT_HEIGHT);

      const expectedRow = `${MODE_LABEL.auto}${MODE_CYCLE_HINT}  claude-sonnet-5 · anthropic`;
      const lines = setup.captureCharFrame().split("\n");
      const modeLine = lines.find((l) => l.includes(expectedRow));
      expect(modeLine).toBeDefined();
      expect(modeLine?.trimEnd().length).toBeLessThanOrEqual(DEFAULT_COLUMNS);
    });

    // ⏸/⏵⏵ may render double-width; captureSpans groups a whole <text>, so indicator span width equalling length is what proves the glyph is one cell.
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

    // Mode row and "↑ scrolled" share one space-between row; if the banner is not reserved from leftover packing, OpenTUI wraps and splits the banner mid-word.
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

    // At 60 columns the banner (26) plus approve-each (22) plus hint (21) would wrap; the hint must yield.
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

    // At 40 columns auto's label (24) plus "Running write_file…" (20) exceed the row, and OpenTUI wraps unless the right side backs off.
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

  describe("plan mode overlay", () => {
    const questions = [
      { id: "q1", prompt: "Target runtime?", options: ["Bun", "Node"] },
      { id: "q2", prompt: "Scope?", options: ["CLI only", "monorepo"] },
    ];
    const submitted = {
      path: "/home/user/.seri/plans/auth-rewrite.md",
      title: "Auth rewrite",
      markdown: "# Auth rewrite\n\nReplace the login flow.\n",
    };

    test("the shift+tab cycle hint is absent while the overlay is on, and the leave hint is present", async () => {
      const { setup, dispatch } = await connect({ route: undefined });
      expect(setup.captureCharFrame()).toContain("(shift+tab to cycle)");
      expect(setup.captureCharFrame()).not.toContain("(ctrl+o to leave)");

      dispatch({ type: "plan-on" });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain(PLAN_MODE_LABEL);
      expect(frame).toContain(PLAN_MODE_LEAVE_HINT.trim());
      expect(frame).not.toContain("(shift+tab to cycle)");
    });

    test("shift+tab does not call onCycleMode while the overlay is on", async () => {
      let calls = 0;
      const { setup, dispatch } = await connect({
        onCycleMode: () => calls++,
      });
      dispatch({ type: "plan-on" });
      await flush(setup);

      setup.mockInput.pressKey(SHIFT_TAB);
      await flush(setup);

      expect(calls).toBe(0);
    });

    test("ctrl+o calls onTogglePlan when the overlay is off", async () => {
      let calls = 0;
      const { setup } = await connect({
        onTogglePlan: () => calls++,
      });

      setup.mockInput.pressKey("o", { ctrl: true });
      await flush(setup);

      expect(calls).toBe(1);
    });

    test("ctrl+o calls onTogglePlan when the overlay is on", async () => {
      let calls = 0;
      const { setup, dispatch } = await connect({
        onTogglePlan: () => calls++,
      });
      dispatch({ type: "plan-on" });
      await flush(setup);

      setup.mockInput.pressKey("o", { ctrl: true });
      await flush(setup);

      expect(calls).toBe(1);
    });

    test("ctrl+o does not call onCycleMode", async () => {
      let cycle = 0;
      let toggle = 0;
      const { setup } = await connect({
        onCycleMode: () => cycle++,
        onTogglePlan: () => toggle++,
      });

      setup.mockInput.pressKey("o", { ctrl: true });
      await flush(setup);

      expect(toggle).toBe(1);
      expect(cycle).toBe(0);
    });

    test("ctrl+o does nothing while a panel is open", async () => {
      let calls = 0;
      const { setup, dispatch } = await connect({
        onTogglePlan: () => calls++,
      });
      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: false,
      });
      await flush(setup);

      setup.mockInput.pressKey("o", { ctrl: true });
      await flush(setup);

      expect(calls).toBe(0);
    });

    test("ctrl+o still calls onTogglePlan under skipPermissions", async () => {
      let calls = 0;
      const { setup } = await connect({
        skipPermissions: true,
        onTogglePlan: () => calls++,
      });

      setup.mockInput.pressKey("o", { ctrl: true });
      await flush(setup);

      expect(calls).toBe(1);
    });

    test("plain o does not toggle and still reaches the input buffer", async () => {
      let calls = 0;
      const submittedTasks: string[] = [];
      const { setup } = await connect({
        onTogglePlan: () => calls++,
        onSubmit: (v) => submittedTasks.push(v),
      });

      await setup.mockInput.typeText("hello");
      setup.mockInput.pressKey("o");
      setup.mockInput.pressEnter();
      await flush(setup);

      expect(calls).toBe(0);
      expect(submittedTasks).toEqual(["helloo"]);
    });

    test("the indicator reads plan mode on in the read-only hue, even under skipPermissions", async () => {
      const { setup, dispatch } = await connect({
        session: session({ permissionMode: "approve-each" }),
        skipPermissions: true,
      });
      dispatch({ type: "plan-on" });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain(PLAN_MODE_LABEL);
      expect(setup.captureCharFrame()).not.toContain("bypass permissions on");
      expect(setup.captureCharFrame()).not.toContain("approve-each mode on");

      const frame = setup.captureSpans();
      const line = frame.lines.find((l) => l.spans.some((s) => s.text.includes(PLAN_MODE_LABEL)));
      const span = line?.spans.find((s) => s.text.includes(PLAN_MODE_LABEL));
      expect(span?.fg.equals(parseColor(theme.mode["read-only"]))).toBe(true);
    });

    test("plain TAB with the overlay on and no panel still does not cycle the mode", async () => {
      let calls = 0;
      const submittedTasks: string[] = [];
      const { setup, dispatch } = await connect({
        onCycleMode: () => calls++,
        onSubmit: (v) => submittedTasks.push(v),
      });
      dispatch({ type: "plan-on" });
      await flush(setup);

      await setup.mockInput.typeText("hello");
      setup.mockInput.pressKey("\t");
      await setup.mockInput.typeText(" world");
      setup.mockInput.pressEnter();
      await flush(setup);

      expect(calls).toBe(0);
      expect(submittedTasks).toEqual(["hello world"]);
    });

    test("the questions panel mounts and PageUp does not scroll behind it", async () => {
      const { setup, dispatch } = await connect();
      for (let i = 0; i < 300; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      dispatch({ type: "plan-questions-requested", questions });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("plan questions");
      expect(frame).toContain("Target runtime?");
      expect(frame).toContain("[Q1]");

      setup.mockInput.pressKey(PAGE_UP);
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("↑ scrolled");
    });

    test("the review panel mounts with approve / request-changes / cancel", async () => {
      const { setup, dispatch } = await connect();
      dispatch({ type: "plan-review-requested", plan: submitted });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Auth rewrite");
      expect(frame).toContain("Approve");
      expect(frame).toContain("Request changes");
      expect(frame).toContain("Cancel");
      expect(frame).toContain(PLAN_MODE_LABEL);
    });
  });

  describe("auth banner", () => {
    test("auth-offer: true does not render the sign-in banner above InputBox", async () => {
      const submitted: string[] = [];
      const { setup, dispatch } = await connect({ onSubmit: (v) => submitted.push(v) });

      dispatch({ type: "auth-offer", show: true });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("Sign in with /login, or create an account with /signup");
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

    test("a pendingSetup panel does not bring the sign-in banner back", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "setup-requested", rows: [] });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("Sign in with /login, or create an account with /signup");
      expect(frame).toContain("/setup — provider API keys");
    });

    test("hides while AuthPanel is showing, even if authOffer stays true", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain(
        "Sign in with /login, or create an account with /signup",
      );

      dispatch({ type: "auth-requested", mode: "login" });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Starting login");
      expect(frame).not.toContain("Sign in with /login, or create an account with /signup");
    });

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
      // OpenTUI holds a bare ESC for a disambiguation window longer than flush()'s macrotask tick.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flush(setup);

      expect(resolved).toEqual([0]);
    });

    test("Escape on the device step also calls onAuthResolved and returns to InputBox", async () => {
      const resolved: number[] = [];
      const submitted: string[] = [];
      let dispatch: Dispatch | undefined;
      const { setup } = await connect({
        connectDispatch: (d) => (dispatch = d),
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
      setup.mockInput.pressArrow("up");
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
      expect(frame).toContain("Unset");

      setup.mockInput.pressKey("z");
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

    // Without flexBasis={0} the config box height stays hostage to the transcript scrollbox's previously-measured size across a resize, not just a panel mount.
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

      // Shrink to listWindowSize(11 - APP_CHROME_ROWS) = 3; with offset still 0, row 9 falls outside [0, 3) unless something re-clamps.
      await resize(setup, DEFAULT_WIDTH, 11);

      expect(setup.captureCharFrame()).toContain("> FAKE_KEY_9");
    });

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
      expect(setup.captureCharFrame()).not.toContain("FAKE_KEY_5");

      // Grow back to a 10-row window with no keypress; offset 10 is stale (widest valid is 5 for 15 rows).
      await resize(setup, DEFAULT_WIDTH, DEFAULT_HEIGHT);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("> FAKE_KEY_12");
      expect(frame).toContain("FAKE_KEY_5");
    });

    test("a panel opened under a command error still fits the viewport", async () => {
      const { setup, dispatch } = await connect();
      await resize(setup, DEFAULT_WIDTH, 20);

      dispatch({ type: "command-error", message: "boom" });
      // Row 0 is a known key so the description line renders; a FAKE_KEY row has no description and would under-count panel height.
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
      expect(frame).not.toContain("─".repeat(DEFAULT_WIDTH));
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

      expect(setup.captureCharFrame()).toContain("Remove write_file");

      setup.mockInput.pressKey("y");
      await flush(setup);

      expect(removed).toEqual(["write_file"]);
    });

    // 15 rows, more than the default 10-row window, so this must truncate and show the footer.
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

  describe("ask_user panel", () => {
    const prompt = {
      prompt: "Which auth?",
      choices: ["cookies", "JWT"],
      allowOther: true,
    };

    test("mounts as question, not plan questions or always, and PageUp does not scroll behind it", async () => {
      const { setup, dispatch } = await connect();
      for (let i = 0; i < 300; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      dispatch({ type: "ask-user-requested", prompt });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("question");
      expect(frame).toContain("Which auth?");
      expect(frame).toContain("cookies");
      expect(frame).not.toContain("plan questions");
      expect(frame).not.toMatch(/\balways\b/i);

      setup.mockInput.pressKey(PAGE_UP);
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("↑ scrolled");
    });

    test("pendingApproval wins over pendingAskUser", async () => {
      const { setup, dispatch } = await connect();
      dispatch({ type: "ask-user-requested", prompt });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("Which auth?");

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: { path: "a.txt" },
        offersAlways: true,
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Write a.txt?");
      expect(frame).not.toContain("Which auth?");
    });
  });

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

    test("pendingEffort wins over pendingChrome", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "chrome-requested", tab: "usage", detail: false });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("Loading hosted usage");

      dispatch({ type: "effort-requested", tiers: ["low", "medium", "high"], selected: 0 });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("/effort — reasoning effort");
      expect(frame).not.toContain("Loading hosted usage");
    });

    test("pendingChrome wins over InputBox", async () => {
      const { setup, dispatch } = await connect();

      dispatch({ type: "chrome-requested", tab: "usage", detail: false });
      await flush(setup);

      expect(setup.captureCharFrame()).toContain("Loading hosted usage");
      expect(setup.captureCharFrame()).toContain("esc close");
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

    test("empty InputBox Down while scrolled up moves the transcript, not the roster", async () => {
      const { setup, dispatch } = await connect();
      startExplore(dispatch, "t1:0", "find a");
      for (let i = 0; i < 300; i++) {
        dispatch({ type: "transcript-append", line: `line ${i}` });
      }
      await flush(setup);

      setup.mockInput.pressKey(HOME);
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("↑ scrolled");
      expect(panelBand(setup.captureCharFrame()).band).not.toContain("> ");

      setup.mockInput.pressArrow("down");
      await flush(setup);
      const afterDown = setup.captureCharFrame();
      expect(panelBand(afterDown).band).not.toContain("> ");
      expect(afterDown).toContain("↑ scrolled");
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
      // OpenTUI holds a bare ESC for a disambiguation window longer than flush()'s macrotask tick.
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
  describe("message queue", () => {
    async function withQueue(...items: string[]) {
      const connected = await connect();
      for (const text of items) {
        connected.dispatch({ type: "queue-appended", id: text, text });
      }
      await flush(connected.setup);
      return connected;
    }

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
      // InputBox coalesces a burst behind its 50ms throttle and paints only the leading-edge character until it fires.
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

    test("a queued message containing a newline still renders as one row", async () => {
      const { setup } = await withQueue(`line one${String.fromCharCode(10)}line two`);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("line one line two");
      expect(rowOf(frame, "line one")).toBe(rowOf(frame, "line two"));
    });
  });

  describe("parent checklist", () => {
    function rowOf(frame: string, needle: string): number {
      return frame.split(String.fromCharCode(10)).findIndex((line) => line.includes(needle));
    }

    const items = [
      { id: "a", content: "find compile flags", status: "done" as const },
      { id: "b", content: "add --minify", status: "in_progress" as const },
      { id: "c", content: "add a size test", status: "pending" as const },
    ];

    test("an empty list draws nothing", async () => {
      const { setup } = await connect();
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("find compile flags");
      expect(frame).not.toContain("in progress");
    });

    test("a session snapshot paints the issue example below the transcript and above the input box", async () => {
      const { setup, dispatch } = await connect({
        session: session({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "c1",
                  toolName: "todo",
                  input: { items },
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "c1",
                  toolName: "todo",
                  output: { type: "json", value: items },
                },
              ],
            },
          ],
        }),
      });
      dispatch({ type: "transcript-append", line: "> earlier task", role: "user" });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("1. find compile flags (done)");
      expect(frame).toContain("2. add --minify (in progress)");
      expect(frame).toContain("3. add a size test (pending)");
      const transcript = rowOf(frame, "earlier task");
      const first = rowOf(frame, "1. find compile flags (done)");
      const inputBox = rowOf(frame, "⏸ approve-each mode on");
      expect(transcript).toBeGreaterThanOrEqual(0);
      expect(transcript).toBeLessThan(first);
      expect(first).toBeLessThan(inputBox);
    });

    test("a successful todo result paints live before messages-updated", async () => {
      const { setup, dispatch } = await connect();
      dispatch({
        type: "loop-event",
        event: { type: "tool-result", name: "todo", result: items },
      });
      await flush(setup);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("1. find compile flags (done)");
      expect(frame).toContain("2. add --minify (in progress)");
      expect(frame).toContain("3. add a size test (pending)");
    });
  });
});
