import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import { render } from "ink-testing-library";
import type { ApprovalAnswer } from "../../src/loop/loop";
import type { ResolvedRoute } from "../../src/provider/routing";
import type { SessionState } from "../../src/session/session";
import { App } from "../../src/tui/App";
import type { ConfigRow, ModelPickerEntry, SetupProviderRow } from "../../src/tui/commands";
import {
  formatContextWindow,
  formatCost,
  formatModeLabel,
  formatModelRow,
  formatRouteLabel,
  formatSetupRow,
  listWindowSize,
  slideWindow,
  visibleTranscript,
} from "../../src/tui/format";
import type { TuiAction } from "../../src/tui/reducer";

function session(overrides: Partial<SessionState<ModelMessage>> = {}): SessionState<ModelMessage> {
  return {
    id: "s1",
    cwd: "/repo",
    systemPrompt: "",
    permissionMode: "approve-each",
    messages: [],
    ...overrides,
  };
}

// AppProps.route is required (D3's own invariant: a PreparedRun cannot exist without a resolved
// route) — every <App> mount in this file needs one, not just the tests that care about its
// rendered content.
function route(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return { model: "claude-sonnet-5", provider: "anthropic", rerouted: false, ...overrides };
}

// A render/dispatch is not reflected in lastFrame() synchronously — same finding as the Phase 3
// spike for useInput, just needing a macrotask tick here rather than a microtask (Ink's own frame
// write is throttled independently of React's own update scheduling).
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function connect() {
  let dispatch: ((action: TuiAction) => void) | undefined;
  const instance = render(
    <App
      session={session()}
      route={route()}
      connectDispatch={(d) => (dispatch = d)}
      done={false}
    />,
  );
  await flush();
  if (dispatch === undefined) throw new Error("connectDispatch never fired");
  return { instance, dispatch };
}

describe("App", () => {
  test("renders the mode indicator for the session's permission mode", async () => {
    let dispatch: ((action: TuiAction) => void) | undefined;
    const instance = render(
      <App
        session={session({ permissionMode: "read-only" })}
        route={route()}
        connectDispatch={(d) => (dispatch = d)}
        done={false}
      />,
    );
    await flush();

    expect(dispatch).toBeDefined();
    expect(instance.lastFrame()).toContain("[read-only]");
  });

  test("a transcript-append dispatch grows the transcript viewport", async () => {
    const { instance, dispatch } = await connect();

    dispatch({ type: "transcript-append", line: "Session s1: permission mode is now auto" });
    await flush();

    expect(instance.lastFrame()).toContain("Session s1: permission mode is now auto");
  });

  // D4: tail-anchored, not head-anchored — 300 lines is comfortably more than any real terminal's
  // row count, so the viewport MUST be showing a slice, and that slice must be the newest end.
  test("a transcript longer than the viewport shows the newest line and hides the oldest, with InputBox still visible", async () => {
    const { instance, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush();

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("line 299");
    expect(frame).not.toContain("line 0");
    // The InputBox's own border (panels/InputBox.tsx) — proves the viewport left room for the
    // live region below it rather than consuming the whole frame.
    expect(frame).toContain("╭");
  });

  test("PageUp shows the scrolled indicator and reveals an older line; End clears it and returns to the newest", async () => {
    const { instance, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    await flush();
    expect(instance.lastFrame()).not.toContain("↑ scrolled");

    instance.stdin.write("\x1b[5~"); // Page Up
    await flush();
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("↑ scrolled — End to follow");
    expect(frame).not.toContain("line 299");

    instance.stdin.write("\x1b[F"); // End
    await flush();
    frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("↑ scrolled");
    expect(frame).toContain("line 299");
  });

  // Regression guard: PageUp/PageDown/Home/End used to fire regardless of which render-ternary
  // branch was active, mutating transcriptScrollOffset in the background while a modal panel
  // (here /config) fully occluded the transcript. Closing the panel would then reveal a
  // transcript scrolled up with no visible keypress of the user's own against it to explain why.
  test("PageUp while a modal panel is open does not scroll the transcript in the background", async () => {
    const { instance, dispatch } = await connect();

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
    await flush();

    instance.stdin.write("\x1b[5~"); // Page Up
    await flush();
    expect(instance.lastFrame()).not.toContain("↑ scrolled");

    dispatch({ type: "config-resolved" });
    await flush();
    const frame = instance.lastFrame() ?? "";
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
    const { instance, dispatch } = await connect();

    for (let i = 0; i < 300; i++) {
      dispatch({ type: "transcript-append", line: `line ${i}` });
    }
    instance.stdin.write("\x1b[H"); // Home
    await flush();

    const highestLineShown = (frame: string) =>
      Math.max(...[...frame.matchAll(/line (\d+)/g)].map((m) => Number(m[1])));
    const highestBefore = highestLineShown(instance.lastFrame() ?? "");

    // @ts-expect-error — ink-testing-library's Stdout stub has no `rows` getter, so this is a plain
    // assignment, not overriding one (same cast the windowSize-shrink test above already uses).
    instance.stdout.rows = 40;
    instance.stdout.emit("resize");
    await flush();

    expect(highestLineShown(instance.lastFrame() ?? "")).toBeGreaterThan(highestBefore);
  });

  // Regression guard (found by review): before `appendLines` (reducer.ts) hard-wrapped at write
  // time, a single streamed answer with embedded newlines committed as ONE transcript array entry
  // — `transcript.length` was 1 regardless of how many terminal rows that entry actually needed to
  // render. `visibleTranscript`'s slice and the scroll clamp both count ARRAY entries, so with
  // length 1, `max = transcript.length - viewportRows` was always <= 0: PageUp/Home could never
  // move the offset at all, and whatever the box couldn't fit was silently clipped by
  // `overflowY="hidden"` with no way to reach it — not just on this test's 25-line answer, but on
  // any answer longer than the viewport happened to be tall that day.
  test("a single answer with more lines than the viewport is fully reachable by scrolling, not silently dropped", async () => {
    const { instance, dispatch } = await connect();

    const answer = Array.from({ length: 25 }, (_, i) => `answer line ${i}`).join("\n");
    dispatch({ type: "transcript-append", line: answer });
    await flush();

    instance.stdin.write("\x1b[H"); // Home
    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("answer line 0");
    expect(frame).toContain("↑ scrolled");
  });

  test("a tool-call loop-event sets the running status, and tool-result clears it", async () => {
    const { instance, dispatch } = await connect();

    dispatch({
      type: "loop-event",
      event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
    });
    await flush();
    expect(instance.lastFrame()).toContain("Running read_file…");

    dispatch({
      type: "loop-event",
      event: { type: "tool-result", name: "read_file", result: "ok" },
    });
    await flush();
    expect(instance.lastFrame()).not.toContain("Running read_file…");
    expect(instance.lastFrame()).toContain("→ read_file");
  });

  test("session-updated refreshes the mode indicator shown", async () => {
    const { instance, dispatch } = await connect();

    dispatch({ type: "session-updated", session: session({ permissionMode: "auto" }) });
    await flush();

    expect(instance.lastFrame()).toContain("[auto]");
  });

  // MEDIUM-E: a paste — delivered to useInput as one multi-character `input` chunk, not one call
  // per character — can embed a real `\r`/`\n` that `key.return` (which only fires for a chunk
  // that IS a bare terminator on its own) never sees. Before this fix it fell into the plain
  // append branch and the terminator ended up embedded literally in the input, never submitting.
  test("a pasted chunk with an embedded newline submits at the first line, not silently swallowing it", async () => {
    const submitted: string[] = [];
    const instance = render(
      <App session={session()} route={route()} onSubmit={(v) => submitted.push(v)} done={false} />,
    );
    await flush();

    instance.stdin.write("first line\nsecond line");
    await flush();

    expect(submitted).toEqual(["first line"]);
    expect(instance.lastFrame()).toContain("second line");
  });

  // MEDIUM-4: a `\r\n` pair (a Windows-clipboard paste) is ONE terminator — stripping only the
  // `\r` used to leave a stray leading `\n` in the retained input, which would render as an
  // (invisible, since Text collapses it) leading blank rather than "second line" starting flush.
  test("a pasted chunk with a CRLF terminator does not leave a stray newline in the retained input", async () => {
    const submitted: string[] = [];
    const instance = render(
      <App session={session()} route={route()} onSubmit={(v) => submitted.push(v)} done={false} />,
    );
    await flush();

    instance.stdin.write("first line\r\nsecond line");
    await flush();

    expect(submitted).toEqual(["first line"]);
    // Not `\nsecond line` — the retained value itself is asserted (not just lastFrame's
    // rendering, which could hide a stray `\n` some other way) via a second write that only
    // submits "second line" cleanly if `after` was exactly that, with no leading control byte.
    instance.stdin.write("\r");
    await flush();
    expect(submitted).toEqual(["first line", "second line"]);
  });

  // Required #4 (thermo-nuclear structural review): the pending-tool live region used a raw
  // JSON.stringify on `args` with no cap, unlike cli.ts's own approval prompt, which already uses
  // truncateArgsDisplay for the exact same reason (write_file's args carry a whole file body,
  // which can otherwise scroll the box itself out of view). pendingTool is set only for
  // write_file/edit, so those are the only tool-call names that populate it.
  test("the pending-tool box truncates a long write_file body instead of rendering it in full", async () => {
    const { instance, dispatch } = await connect();

    dispatch({
      type: "loop-event",
      event: {
        type: "tool-call",
        name: "write_file",
        args: { path: "a.txt", content: "x".repeat(300) },
      },
    });
    await flush();

    // "…)" specifically, not a bare "…": the reducer's own status line ("Running write_file…")
    // already contains an ellipsis unconditionally, on both the truncated and untruncated
    // renders — that alone doesn't distinguish them, measured by writing this test with a plain
    // toContain("…") first and watching it pass against the pre-fix raw JSON.stringify too. The
    // truncated render's own trailing "…)" — the ellipsis immediately followed by the closing
    // paren truncateArgsDisplay's own output sits inside — only exists once truncation actually
    // ran; the untruncated version's args string runs to its real, un-ellipsized end instead. Not
    // trying to assert the FULL args text is absent either: Ink wraps a long line across the
    // pending-tool box's own bordered rows, breaking up any single long contiguous substring
    // regardless of whether truncation happened, so `not.toContain(the 300-character body)` is
    // not a discriminating check on its own — measured the same way.
    expect(instance.lastFrame()).toContain("…)");
  });

  // HIGH-B/MEDIUM-C: Ctrl-D calls the onQuit prop directly — App.tsx wires it through to
  // InputBox unconditionally, so this is the same trigger runTui's own quit() attaches to.
  test("Ctrl-D calls onQuit", async () => {
    let quit = false;
    const instance = render(
      <App session={session()} route={route()} onQuit={() => (quit = true)} done={false} />,
    );
    await flush();

    instance.stdin.write("\x04");
    await flush();

    expect(quit).toBe(true);
  });

  // Findings 1+5 (thermo-nuclear structural review, round 6): the TUI-native approval prompt —
  // the ORIGINAL research-spec design ("a TUI supplies a different function of the identical
  // signature... with zero change to loop.ts/gate.ts") that every earlier round of this branch
  // left unbuilt.
  describe("approval prompt", () => {
    test("renders in place of the input box, matching makeApprovalPrompt's own prompt text", async () => {
      const { instance, dispatch } = await connect();

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: { path: "a.txt", content: "x" },
        offersAlways: true,
      });
      await flush();

      // Split across two checks, not one long toContain: the box wraps this line across its own
      // bordered rows (measured — the full string never appears contiguously in lastFrame()), the
      // same wrapping every other long-line assertion in this file already works around.
      expect(instance.lastFrame()).toContain(
        `Approve write_file({"path":"a.txt","content":"x"})? [y]es / [a]lways (saved for this project) /`,
      );
      expect(instance.lastFrame()).toContain("[N]o");
    });

    test("y answers 'once', a answers 'always' when offered, and anything else (n, Enter, an unoffered a) answers 'no'", async () => {
      const answers: ApprovalAnswer[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onApprovalAnswer={(answer) => answers.push(answer)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush();
      instance.stdin.write("y");
      await flush();
      expect(answers).toEqual(["once"]);

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush();
      instance.stdin.write("a");
      await flush();
      expect(answers).toEqual(["once", "always"]);

      // Not offered this time — "a" falls through to "no", the same "anything unrecognised is
      // 'no'" rule makeApprovalPrompt itself applies.
      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: false,
      });
      await flush();
      instance.stdin.write("a");
      await flush();
      expect(answers).toEqual(["once", "always", "no"]);

      // Enter defaults to "no" — the bracketed capital in "[N]o".
      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush();
      instance.stdin.write("\r");
      await flush();
      expect(answers).toEqual(["once", "always", "no", "no"]);
    });

    // Mutual exclusivity (App.tsx's own comment): while an approval is pending, InputBox is not
    // mounted at all, so ordinary typing does not reach onSubmit — it reaches ApprovalBox's own
    // handler instead, which (per the test above) answers "no" for anything that isn't y/a/Enter.
    test("input while an approval is pending does not reach onSubmit", async () => {
      const submitted: string[] = [];
      const answers: ApprovalAnswer[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onSubmit={(v) => submitted.push(v)}
          onApprovalAnswer={(answer) => answers.push(answer)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush();
      // A single keystroke, not a multi-character chunk: this is only about confirming the
      // keypress reached ApprovalBox instead of InputBox, not about the multi-character-chunk
      // handling MEDIUM-E's own tests already cover — a chunk here could, after ApprovalBox
      // resolves and InputBox remounts mid-write, land partly in the now-mounted InputBox instead,
      // which is not what this test is checking.
      instance.stdin.write("h");
      await flush();

      expect(submitted).toEqual([]);
      // Not y/a/Enter — resolved "no", confirming the keystroke was consumed by ApprovalBox.
      expect(answers).toEqual(["no"]);
    });

    // Round 8 code review, finding 2: Ink's own parser (parse-keypress.js/use-input.js) reports
    // `input === ""` for these — the same empty-input shape key.ctrl/key.meta already special-case
    // below — because they carry no printable text at all, unlike an ordinary "wrong" letter. The
    // pre-fix code had no guard for that shape and fell straight into the "anything unrecognised is
    // 'no'" catch-all meant for actual mistyped text, so a user reflexively reaching for Enter with
    // an arrow key or Backspace silently denied a write they never meant to answer. The readline-
    // based prompt (makeApprovalPrompt, cli.ts) does not have this problem: those keys only edit or
    // no-op its line buffer, and nothing submits until Enter.
    test("navigation and editing keys (arrow, backspace) are ignored rather than treated as an implicit deny", async () => {
      const answers: ApprovalAnswer[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onApprovalAnswer={(answer) => answers.push(answer)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush();

      instance.stdin.write("\x1b[A"); // up arrow
      await flush();
      instance.stdin.write("\x7f"); // backspace
      await flush();
      expect(answers).toEqual([]);

      // Still live, not wedged: an actual keystroke still resolves it.
      instance.stdin.write("y");
      await flush();
      expect(answers).toEqual(["once"]);
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

    // D1/D2 (feature-plan.md): the picker's own row shape, ModelPickerEntry — this file's
    // existing `entry()` fixture still builds the underlying ModelCatalogEntry, wrapped here for
    // every test that only cares about "some row exists," not routing/key-configuration specifics.
    function row(overrides: Partial<ModelCatalogEntry> = {}): ModelPickerEntry {
      return {
        entry: entry(overrides),
        keyConfigured: true,
        alternatives: 0,
        gatewayReachable: false,
      };
    }

    test("renders in place of the input box once requested", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "model-picker-requested", entries: [row()] });
      await flush();

      expect(instance.lastFrame()).toContain("Llama 3.3 70B");
    });

    // The concrete mechanical proof of "context preserved" (feature-plan.md's own acceptance
    // criterion): onModelSelected only ever carries the picked model/provider — `messages` (and
    // everything else about the session) is never part of the pick at all, so there is nothing to
    // migrate or drop; the reducer's own model-picker-resolved merges it onto whatever session is
    // current when the pick resolves (reducer.test.ts covers that merge directly).
    test("typing filters the list, and Enter resolves the highlighted entry", async () => {
      const selected: Array<{ model: string; provider: ModelProvider }> = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const startingSession = session({ messages: [{ role: "user", content: "hi" }] });
      const instance = render(
        <App
          session={startingSession}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onModelSelected={(pick) => selected.push(pick)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({
        type: "model-picker-requested",
        entries: [
          row({ id: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B" }),
          row({ id: "llama-3.1-8b-instant", displayName: "Llama 3.1 8B" }),
        ],
      });
      await flush();

      // Narrows to the second entry only — "8b" is not a substring of the first entry's id or
      // displayName.
      instance.stdin.write("8b");
      await flush();
      expect(instance.lastFrame()).toContain("8b");

      instance.stdin.write("\r");
      await flush();

      expect(selected).toEqual([{ model: "llama-3.1-8b-instant", provider: "groq" }]);
    });

    test("Escape and Ctrl-D both cancel without resolving a model", async () => {
      const cancelled: string[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onModelPickerCancel={() => cancelled.push("cancelled")}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({ type: "model-picker-requested", entries: [row()] });
      await flush();
      instance.stdin.write("\x1b"); // Escape
      // A bare Escape byte is ambiguous with the start of a longer ANSI sequence (an arrow key,
      // say), so Ink's own input parser holds it for a short window (App.js's own
      // pendingInputFlushDelayMilliseconds, 20ms) before treating it as a standalone Escape
      // keypress — longer than the plain macrotask tick `flush()` waits everywhere else in this
      // file.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(cancelled).toEqual(["cancelled"]);

      dispatch({ type: "model-picker-requested", entries: [row()] });
      await flush();
      instance.stdin.write("\x04"); // Ctrl-D
      await flush();
      expect(cancelled).toEqual(["cancelled", "cancelled"]);
    });

    test("shows a +N more hint once the filtered list exceeds the visible window", async () => {
      const { instance, dispatch } = await connect();
      const entries = Array.from({ length: 12 }, (_, i) =>
        row({ id: `model-${i}`, displayName: `Model ${i}` }),
      );

      dispatch({ type: "model-picker-requested", entries });
      await flush();

      expect(instance.lastFrame()).toContain("+2 more — keep typing to narrow");
    });

    // Regression guard: `remaining` used to be `filtered.length - visible.length`, which counts
    // entries hidden ABOVE the window too and stays flat at `filtered.length - windowSize` for as
    // long as the window is full — the hint never counted down while scrolling toward the bottom,
    // and never disappeared even once every remaining entry was on screen.
    test("the +N more hint count decreases while scrolling down, disappearing at the bottom", async () => {
      const { instance, dispatch } = await connect();
      const entries = Array.from({ length: 12 }, (_, i) =>
        row({ id: `model-${i}`, displayName: `Model ${i}` }),
      );

      dispatch({ type: "model-picker-requested", entries });
      await flush();
      expect(instance.lastFrame()).toContain("+2 more — keep typing to narrow");

      for (let i = 0; i < 11; i++) {
        instance.stdin.write("\x1b[B"); // Down arrow
        await flush();
      }

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("Model 11");
      expect(frame).not.toContain("more — keep typing to narrow");
    });

    // C1: the real bug — the visible window used to always be the first MODEL_PICKER_WINDOW
    // entries regardless of `selectedIndex`, so Down past the 10th entry moved the highlight
    // somewhere nothing on screen showed. Down 15 times over 20 entries lands well past the
    // original window; this checks BOTH halves the task's own comment calls out: the list actually
    // scrolls (the 16th entry, id "model-15", becomes visible; the 1st, "model-0", scrolls out),
    // AND the row Enter resolves is the one actually highlighted — an off-by-one in the scroll math
    // would resolve a neighbour instead.
    test("Down past the visible window scrolls the list, and Enter selects the highlighted row", async () => {
      const selected: Array<{ model: string; provider: ModelProvider }> = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onModelSelected={(pick) => selected.push(pick)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      const entries = Array.from({ length: 20 }, (_, i) =>
        row({ id: `model-${i}`, displayName: `Model ${i}` }),
      );
      dispatch({ type: "model-picker-requested", entries });
      await flush();

      // One write per keypress, not one write carrying all 15 escape sequences concatenated —
      // Ink's own input parser only recognised the first arrow key when they arrived as a single
      // chunk (measured), the same "one write per keystroke" constraint this file's other
      // multi-keypress tests already work under.
      for (let i = 0; i < 15; i++) {
        instance.stdin.write("\x1b[B"); // Down arrow
        await flush();
      }

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("Model 15");
      expect(frame).not.toContain("Model 0 ");

      instance.stdin.write("\r");
      await flush();

      expect(selected).toEqual([{ model: "model-15", provider: "groq" }]);
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
      const { instance, dispatch } = await connect();

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("groq");
      expect(frame).toContain("openrouter");
      expect(frame).toContain("anthropic");
      expect(frame).toContain("openai");
      expect(frame).toContain("google");
      expect(frame).toContain("sk-o...abcd");
      // The env row shows D8's own disabled-remove reason, not a masked value.
      expect(frame).toContain("set by $ANTHROPIC_API_KEY in your environment");
    });

    // Bug fixed here (code-review, PR #73, round 3, item #1): Enter is dead in the real TUI twice
    // before this test existed — Ink sets `input` to `''` for every named key including Enter, and
    // SetupList's own `if (input.length === 0) return;` guard used to run BEFORE the `key.return`
    // check, so Enter never reached it; only the 'a' letter shortcut (a real, non-empty `input`)
    // worked. `"\r"`, not `"a"` — that's the whole point of this test, per the panel's own hint
    // text ("Enter/a add or replace") promising both work.
    test("the list step: Enter (not the 'a' shortcut) selects the highlighted row via onSetupSelect", async () => {
      const selected: ModelProvider[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onSetupSelect={(provider) => selected.push(provider)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush();

      // One Down reaches openrouter (index 1) — CATALOG_PROVIDERS order matches setupRows() above.
      instance.stdin.write("\x1b[B");
      await flush();
      instance.stdin.write("\r");
      await flush();

      expect(selected).toEqual(["openrouter"]);
    });

    // Same bug, the Delete branch: Ink's Delete key is `\x1b[3~` (parse-keypress.js), a DIFFERENT
    // sequence from backspace's `\x7f` — distinct enough that fixing Enter alone would not have
    // proven this branch too.
    test("the list step: Delete (not the 'r' shortcut) requests removal via onSetupRemove, when the row is removable", async () => {
      const removeRequested: ModelProvider[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onSetupRemove={(provider) => removeRequested.push(provider)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush();

      // openrouter (index 1) is the removable row in setupRows() above.
      instance.stdin.write("\x1b[B");
      await flush();
      instance.stdin.write("\x1b[3~");
      await flush();

      expect(removeRequested).toEqual(["openrouter"]);
    });

    // The negative control this pair rests on: a non-removable row's Delete must still be a no-op,
    // the same guard the 'r' shortcut already had — proving the fix didn't drop that check while
    // moving the branch earlier.
    test("the list step: Delete on a non-removable row calls neither onSetupSelect nor onSetupRemove", async () => {
      const selected: ModelProvider[] = [];
      const removeRequested: ModelProvider[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onSetupSelect={(provider) => selected.push(provider)}
          onSetupRemove={(provider) => removeRequested.push(provider)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      // groq (index 0, the default selection) is source: "unset", removable: false.
      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush();

      instance.stdin.write("\x1b[3~");
      await flush();

      expect(selected).toEqual([]);
      expect(removeRequested).toEqual([]);
    });

    // The key-leak guard, and its negative control: `.claude/rules/code-quality.md` requires this
    // assertion to have been SEEN to fail. Verified by temporarily changing SetupEnterKey's own
    // render from `"*".repeat(value.length)` back to the raw `value` and re-running this exact
    // test: it failed, printing the typed string `sk-distinctive-secret-12345` in `lastFrame()`,
    // confirming the assertion actually exercises the masking rather than trivially passing
    // because the string never appeared anywhere for an unrelated reason. Reverted immediately
    // after — the fix below is what's committed.
    test("a typed key is masked in the frame, never rendered raw", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush();
      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider: "groq",
          keyName: "GROQ_API_KEY",
          busy: false,
        },
      });
      // Two ticks, not one: measured on WSL (the first character sent after only one `flush()`
      // was silently dropped, deterministically — SetupEnterKey's own useInput registers a tick
      // later than the component itself commits, the same class of mount-timing gap this file's
      // pty suite already needed a much longer, dedicated wait for around a component swap).
      await flush();
      await flush();

      const secret = "sk-distinctive-secret-12345";
      instance.stdin.write(secret);
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).not.toContain(secret);
      expect(frame).toContain("*".repeat(secret.length));
    });

    test("Enter on the enter-key step submits the typed value via onSetupKeyEntered", async () => {
      const entered: Array<{ provider: ModelProvider; value: string }> = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onSetupKeyEntered={(provider, value) => entered.push({ provider, value })}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider: "openai",
          keyName: "OPENAI_API_KEY",
          busy: false,
        },
      });
      await flush();

      instance.stdin.write("sk-my-key");
      await flush();
      instance.stdin.write("\r");
      await flush();

      expect(entered).toEqual([{ provider: "openai", value: "sk-my-key" }]);
    });

    test("while busy, the panel renders Validating… and ignores input", async () => {
      const entered: Array<{ provider: ModelProvider; value: string }> = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onSetupKeyEntered={(provider, value) => entered.push({ provider, value })}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({
        type: "setup-step",
        state: {
          step: "enter-key",
          provider: "openai",
          keyName: "OPENAI_API_KEY",
          busy: true,
        },
      });
      await flush();

      expect(instance.lastFrame() ?? "").toContain("Validating…");

      instance.stdin.write("\r");
      await flush();

      expect(entered).toEqual([]);
    });

    test("confirm-remove: 'y' confirms via onSetupRemove, anything else cancels back via onSetupBack", async () => {
      const removed: ModelProvider[] = [];
      const backCalls: number[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onSetupRemove={(provider) => removed.push(provider)}
          onSetupBack={() => backCalls.push(backCalls.length)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({
        type: "setup-step",
        state: {
          step: "confirm-remove",
          provider: "openrouter",
          keyName: "OPENROUTER_API_KEY",
        },
      });
      await flush();
      instance.stdin.write("n");
      await flush();

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
      await flush();
      instance.stdin.write("y");
      await flush();

      expect(removed).toEqual(["openrouter"]);
    });

    // Render precedence (App.tsx's own render ternary): pendingApproval beats pendingModelPicker
    // beats pendingSetup beats InputBox.
    test("pendingApproval takes precedence over pendingSetup, which takes precedence over InputBox", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "setup-requested", rows: setupRows() });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("/setup — provider API keys");

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush();

      const frame = instance.lastFrame() ?? "";
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

  // D2-D5 (feature-plan.md): the mode-indicator row's own content, factored out as the pure
  // `formatModeLabel` (App's own comment explains why: unit-testable without mounting Ink, same
  // reasoning formatModelRow's own extraction already used). `route` can be undefined
  // (runGuidedSetup, cli.ts, mounts App before any provider key exists) — covered below.
  describe("formatModeLabel", () => {
    const nonRerouted = route();
    const rerouted = route({ provider: "openrouter", rerouted: true, reason: "ANTHROPIC_API_KEY" });

    test("full width (>=76 cols): mode indicator, model, and 'your key'", () => {
      expect(formatModeLabel("[approve-each]", nonRerouted, 76)).toBe(
        "[approve-each]  claude-sonnet-5 · your key",
      );
    });

    test("full width with a rerouted route: '→ <provider>'", () => {
      expect(formatModeLabel("[approve-each]", rerouted, 100)).toBe(
        "[approve-each]  claude-sonnet-5 · → openrouter",
      );
    });

    // D5: compact tier (52-75 cols) keeps the model name but drops the route suffix.
    test("compact width (52-75 cols): mode indicator and model, no route label", () => {
      expect(formatModeLabel("[approve-each]", nonRerouted, 60)).toBe(
        "[approve-each]  claude-sonnet-5",
      );
      expect(formatModeLabel("[approve-each]", nonRerouted, 75)).toBe(
        "[approve-each]  claude-sonnet-5",
      );
    });

    // D5's own negative control: below 52 cols the row reverts to EXACTLY today's pre-change
    // output — mode indicator only, regardless of what `route` carries — proving the model+route
    // label can never crowd the spinner/status text off screen at any width.
    test("minimal width (<52 cols): mode indicator only, byte-identical to the pre-change row", () => {
      expect(formatModeLabel("[approve-each]", nonRerouted, 51)).toBe("[approve-each]");
      expect(formatModeLabel("[approve-each]", rerouted, 10)).toBe("[approve-each]");
    });

    // post-review fix: a real catalog id (an OpenRouter id is easily 40+ chars) used to go into
    // the row unbounded, so it could overflow the exact terminal width the tier boundary assumed
    // it fit in. Capped to NAME_WIDTH (22, the same width the picker table already truncates
    // model names to), in both the tiers that render the model name.
    test("long model id is truncated to NAME_WIDTH in both compact and full tiers", () => {
      const longModel = route({ model: "openrouter/deepseek/deepseek-r1-distill-llama-70b" });
      expect(formatModeLabel("[approve-each]", longModel, 60)).toBe(
        "[approve-each]  openrouter/deepseek/d…",
      );
      expect(formatModeLabel("[approve-each]", longModel, 76)).toBe(
        "[approve-each]  openrouter/deepseek/d… · your key",
      );
    });

    // runGuidedSetup (cli.ts) mounts App with route: undefined before any provider key exists —
    // the mode indicator must fall back to the bare label at every width, never a fabricated
    // "your key"/"→ <provider>" for a route that does not exist yet.
    test("undefined route: mode indicator only, at every width", () => {
      expect(formatModeLabel("[approve-each]", undefined, 100)).toBe("[approve-each]");
      expect(formatModeLabel("[approve-each]", undefined, 60)).toBe("[approve-each]");
      expect(formatModeLabel("[approve-each]", undefined, 10)).toBe("[approve-each]");
    });
  });

  describe("visibleTranscript", () => {
    test("a transcript shorter than the viewport is shown in full", () => {
      expect(visibleTranscript(["a", "b", "c"], 5, 0)).toEqual(["a", "b", "c"]);
    });

    // D4: tail-anchored, not head-anchored — a transcript longer than the viewport shows its
    // NEWEST lines by default, matching what scrolled-by terminal output would already show.
    test("a transcript longer than the viewport shows the newest lines, not the oldest", () => {
      expect(visibleTranscript(["a", "b", "c", "d", "e"], 3, 0)).toEqual(["c", "d", "e"]);
    });

    test("a positive offset slides the window toward older lines", () => {
      expect(visibleTranscript(["a", "b", "c", "d", "e"], 3, 1)).toEqual(["b", "c", "d"]);
    });

    test("an offset large enough to reach the start still returns at most `rows` lines", () => {
      expect(visibleTranscript(["a", "b", "c"], 5, 10)).toEqual([]);
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

  describe("listWindowSize", () => {
    // ink-testing-library's own `getWindowSize` fallback (App.test.tsx's own convention elsewhere
    // in this file) floors rows at 24 — 24 - PANEL_CHROME_ROWS(9) = 15, clamped down to
    // LIST_WINDOW_MAX(10). This is the "+2 more — keep typing to narrow" regression guard's own
    // underlying fact: ModelPicker's window stays 10 under the test harness regardless of the host
    // terminal's real size.
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
    // useTerminalWidth's own live-resize wiring — formatModeLabel's tests above already cover the
    // tier DECISION logic as a pure function, so this is the one Ink-level smoke test needed to
    // confirm a real stdout `resize` event actually reaches the rendered row end-to-end.
    test("renders the model+route label at the default width, and drops it after a resize below the compact tier", async () => {
      const instance = render(<App session={session()} route={route()} done={false} />);
      await flush();
      expect(instance.lastFrame() ?? "").toContain("your key");

      Object.defineProperty(instance.stdout, "columns", { value: 40, configurable: true });
      instance.stdout.emit("resize");
      await flush();

      expect(instance.lastFrame() ?? "").not.toContain("claude-sonnet-5");
    });

    // runGuidedSetup's own mount shape (cli.ts): no PreparedRun exists yet, so route is undefined.
    test("mounts with route undefined and shows no fabricated route text", async () => {
      const instance = render(<App session={session()} route={undefined} done={false} />);
      await flush();
      const frame = instance.lastFrame() ?? "";
      expect(frame).not.toContain("your key");
      expect(frame).not.toContain("→");
    });
  });

  // Stage A scaffolding (cli-commands-to-tui feature-plan.md): nothing dispatches
  // auth-requested/config-requested/permissions-requested yet — these tests seed the reducer's
  // state directly (auth-offer/auth-step/config-step/permissions-step) to prove the render wiring
  // itself is correct ahead of Stages C-D's dispatchers.
  describe("auth banner", () => {
    test("show: true renders the offer alongside InputBox, not in place of it", async () => {
      const submitted: string[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onSubmit={(v) => submitted.push(v)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({ type: "auth-offer", show: true });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("/login");
      expect(frame).toContain("/signup");
      // Non-blocking proof: InputBox is still mounted (not replaced) — typing still reaches
      // onSubmit, exactly as it would with the banner absent.
      instance.stdin.write("still typing\r");
      await flush();
      expect(submitted).toEqual(["still typing"]);
    });

    test("show: false renders nothing extra", async () => {
      const { instance, dispatch } = await connect();
      const before = instance.lastFrame() ?? "";

      dispatch({ type: "auth-offer", show: false });
      await flush();

      expect(instance.lastFrame() ?? "").toBe(before);
    });

    // Stage C: the banner sits ABOVE the render ternary (App.tsx's own comment) rather than as one
    // of its branches — the zeroKeys x noAuth "both at once" cell, component level: a first run
    // with no provider key opens /setup's own panel, and the banner must still render alongside it
    // rather than being replaced the way ApprovalBox/ModelPicker/SetupPanel replace each other.
    test("renders alongside a pendingSetup panel, not replaced by it", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "setup-requested", rows: [] });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("/login");
      expect(frame).toContain("/setup — provider API keys");
    });

    // Bug fix (thermo-nuclear + code-review, round 4 — the root-cause fix): three earlier rounds
    // all patched a new place that forgot to dispatch `auth-offer: false` the moment a login
    // attempt opened; the actual fix is deriving the banner from `pendingAuth` (App.tsx's own
    // `state.authOffer && state.pendingAuth === undefined`) instead of commanding it. This test
    // dispatches ONLY `auth-requested` — no manual `auth-offer` dispatch at all, unlike the old
    // version of this test — and the banner still hides, because `authOffer` itself is
    // deliberately left `true` here: the derivation is what's doing the work, not a stale flag
    // that happens to already be false.
    test("hides while AuthPanel is showing, purely from pendingAuth being set — authOffer itself stays true", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("/login");

      dispatch({ type: "auth-requested", mode: "login" });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("Starting login");
      expect(frame).not.toContain("Sign in with /login, or create an account with /signup");
    });

    // Bug fix (this same round): the derivation above only covers "hide while the panel is open"
    // — the instant a successful login's own `auth-resolved` clears `pendingAuth` again, the
    // derivation reduces to bare `authOffer`, which was never updated to reflect the session that
    // just got saved. createAuthHandlers.onLogin's own success path (tui/handlers.ts) recomputes
    // it fresh right after, exactly like onLogout's `show: true` and the mount/onAuthResolved
    // recomputes already do for their own real state changes — this reproduces that exact three-dispatch
    // sequence and checks the banner does NOT flash back on.
    test("stays hidden after a successful login, not just while the panel is open", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "auth-offer", show: true });
      dispatch({ type: "auth-requested", mode: "login" });
      await flush();

      dispatch({ type: "transcript-append", line: "Logged in as a@example.com" });
      dispatch({ type: "auth-resolved" });
      dispatch({ type: "auth-offer", show: false });
      await flush();

      expect(instance.lastFrame() ?? "").not.toContain(
        "Sign in with /login, or create an account with /signup",
      );
    });
  });

  describe("auth panel", () => {
    test("starting step shows a brief starting message for the given mode", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "auth-requested", mode: "signup" });
      await flush();

      expect(instance.lastFrame() ?? "").toContain("signup");
    });

    test("device step shows the verification URL and user code", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "auth-requested", mode: "login" });
      await flush();
      dispatch({
        type: "auth-step",
        state: {
          step: "device",
          mode: "login",
          verificationUri: "https://example.com/device",
          userCode: "ABCD-1234",
        },
      });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("https://example.com/device");
      expect(frame).toContain("ABCD-1234");
    });

    // Color (theme.error) is not asserted: ink-testing-library's lastFrame() in this test
    // environment carries no ANSI codes (measured against a plain <Text color="red">) — the same
    // reason no other test in this file asserts on a theme color, only on rendered text.
    test("result step shows the message, for both a success and an error result", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "auth-requested", mode: "login" });
      await flush();
      dispatch({
        type: "auth-step",
        state: { step: "result", message: "Signed in as a@example.com", error: false },
      });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("Signed in as a@example.com");

      dispatch({ type: "auth-requested", mode: "login" });
      await flush();
      dispatch({
        type: "auth-step",
        state: { step: "result", message: "Login failed: expired code", error: true },
      });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("Login failed: expired code");
    });

    // auth-resolved is the reducer action createAuthHandlers' own onLogin/onLogout (tui/handlers.ts)
    // fire once a device-flow result lands — proves the panel's own text (including the result step's
    // message, the closest thing this panel has to hint text) is fully gone afterward, not just
    // that SOME frame changed, and that InputBox is genuinely back (accepts input), not merely
    // that nothing matched the render ternary's earlier branches.
    test("clears the panel entirely, restoring InputBox", async () => {
      const submitted: string[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onSubmit={(v) => submitted.push(v)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({ type: "auth-requested", mode: "login" });
      await flush();
      dispatch({
        type: "auth-step",
        state: { step: "result", message: "Signed in as a@example.com", error: false },
      });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("Signed in as a@example.com");

      dispatch({ type: "auth-resolved" });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).not.toContain("Signed in as a@example.com");
      // A second flush: InputBox is a fresh mount here (swapped in for AuthPanel), and its own
      // useInput needs an extra tick to register — the same mount-timing gap PermissionsPanel's
      // own confirm-remove test above already needed for an identical component swap.
      await flush();
      instance.stdin.write("back to typing\r");
      await flush();
      expect(submitted).toEqual(["back to typing"]);
    });

    // Bug fix (coordinator follow-up on Stage C): before AuthPanel's own useInput existed, a
    // failed login/signup (createAuthHandlers' own catch, tui/handlers.ts — a denied/expired code, a
    // network error) left the "result" step up with no keyboard path back at all, not even
    // Ctrl-C. Presses a REAL key (not a direct auth-resolved dispatch, which "clears the panel
    // entirely" above already covers) to prove AuthPanel's own Enter/Esc handling is actually
    // wired through App.tsx's onAuthResolved prop — the same wiring-proof shape ConfigPanel's own
    // "Esc on the list step calls onConfigClose" test uses.
    test("Enter on the result step calls onAuthResolved and returns to InputBox", async () => {
      const resolved: number[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onAuthResolved={() => resolved.push(resolved.length)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({ type: "auth-requested", mode: "login" });
      await flush();
      dispatch({
        type: "auth-step",
        state: { step: "result", message: "Authorization was denied.", error: true },
      });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("Authorization was denied.");

      instance.stdin.write("\r");
      await flush();

      expect(resolved).toEqual([0]);
    });

    // Escape, mirroring SetupConfirmRemove's own Esc-cancels convention (SetupPanel.tsx) — the
    // dismissal precedent this fix follows.
    test("Escape on the result step also calls onAuthResolved", async () => {
      const resolved: number[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onAuthResolved={() => resolved.push(resolved.length)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({ type: "auth-requested", mode: "login" });
      await flush();
      dispatch({
        type: "auth-step",
        state: { step: "result", message: "The login request expired.", error: true },
      });
      await flush();

      instance.stdin.write("\x1b"); // Escape
      // A bare Escape byte is ambiguous with the start of a longer ANSI sequence — Ink's own
      // input parser holds it for a short window before treating it as standalone (ConfigPanel's
      // own Escape test below needs the same wait for the same reason).
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(resolved).toEqual([0]);
    });

    // The real soft-lock this fix closes (thermo-nuclear + code-review, round 4): before this,
    // NOTHING dismissed "starting"/"device" — no useInput handling on either step, and Ctrl-C
    // routes to onCancel (a hard process kill with no turn in flight to arm the cancel slot), not
    // to clearing pendingAuth. A mistyped /login or a slow WorkOS device flow used to cost the
    // whole TUI session.
    test("Escape on the device step also calls onAuthResolved and returns to InputBox", async () => {
      const resolved: number[] = [];
      const submitted: string[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          // Unlike the two result-step tests above (which only prove the prop fires), this one
          // also dispatches auth-resolved itself — cli.ts's own onAuthResolved wiring does the
          // same (its own comment) — so the frame assertions below observe the real end-to-end
          // effect, not just that the callback ran.
          onAuthResolved={() => {
            resolved.push(resolved.length);
            dispatch?.({ type: "auth-resolved" });
          }}
          onSubmit={(v) => submitted.push(v)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({ type: "auth-requested", mode: "login" });
      await flush();
      dispatch({
        type: "auth-step",
        state: {
          step: "device",
          mode: "login",
          verificationUri: "https://example.com/device",
          userCode: "ABCD-1234",
        },
      });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("ABCD-1234");

      instance.stdin.write("\x1b"); // Escape
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(resolved).toEqual([0]);
      const frame = instance.lastFrame() ?? "";
      expect(frame).not.toContain("ABCD-1234");
      // A second flush: InputBox is a fresh mount here (swapped in for AuthPanel), and its own
      // useInput needs an extra tick to register — the same mount-timing gap this describe
      // block's own "clears the panel entirely" test above already needed for an identical swap.
      await flush();
      instance.stdin.write("back to typing\r");
      await flush();
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
      const { instance, dispatch } = await connect();

      dispatch({ type: "config-requested", rows: configRows() });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("Automatic verification: on");
      expect(frame).not.toContain("SERI_VERIFY_ENABLED");
      expect(frame).toContain("SERI_SOME_OTHER_KEY");
      expect(frame).toContain("sk-d...2345");
    });

    test("the selected row's description renders, and moving Down swaps it for the next row's", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "config-requested", rows: configRows() });
      await flush();

      expect(instance.lastFrame() ?? "").toContain(
        "Run the verify command after each file edit and show failures to the model.",
      );

      instance.stdin.write("\x1b[B"); // Down
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).not.toContain(
        "Run the verify command after each file edit and show failures to the model.",
      );
    });

    test("the hint reads 'Enter/a toggle' on the boolean row and 'Enter/a set' after moving to a string row", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "config-requested", rows: configRows() });
      await flush();

      expect(instance.lastFrame() ?? "").toContain("Enter/a toggle");

      instance.stdin.write("\x1b[B"); // Down
      await flush();

      expect(instance.lastFrame() ?? "").toContain("Enter/a set");
    });

    test("Enter on the boolean row calls onConfigSelect with its key", async () => {
      const selected: string[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onConfigSelect={(key) => selected.push(key)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({ type: "config-requested", rows: configRows() });
      await flush();

      instance.stdin.write("\r"); // Enter
      await flush();

      expect(selected).toEqual(["SERI_VERIFY_ENABLED"]);
    });

    // The key-leak guard, mirroring SetupEnterKey's own test above: a raw secret-shaped value must
    // never appear in the frame, on the list step (only the already-masked value is shown) or the
    // enter-value step (typed characters render as "*").
    test("a raw secret-shaped value never appears in the frame", async () => {
      const { instance, dispatch } = await connect();

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
      await flush();

      expect(instance.lastFrame() ?? "").not.toContain("sk-distinctive-secret-12345");

      dispatch({
        type: "config-step",
        state: { step: "enter-value", key: "SERI_SOME_OTHER_KEY", busy: false },
      });
      await flush();
      await flush();

      const secret = "sk-distinctive-secret-12345";
      instance.stdin.write(secret);
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).not.toContain(secret);
      expect(frame).toContain("*".repeat(secret.length));
    });

    // Review round 3 finding (MEDIUM-1's own test coverage gap): onConfigClose is an optional
    // AppProps handler with nothing that goes red if App.tsx's own render call stopped passing it
    // through to ConfigPanel — this proves the wiring, not just that ConfigList's own Esc handling
    // works (that's this component's own concern, already implicit in it having a prop at all).
    test("Esc on the list step calls onConfigClose", async () => {
      const closed: number[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onConfigClose={() => closed.push(closed.length)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({ type: "config-requested", rows: configRows() });
      await flush();

      instance.stdin.write("\x1b"); // Escape
      // A bare Escape byte is ambiguous with the start of a longer ANSI sequence — Ink's own
      // input parser holds it for a short window before treating it as standalone (the model
      // picker's own Escape test above needs the same wait for the same reason).
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(closed).toEqual([0]);
    });

    // ConfigConfirmUnset's own convention (mirroring SetupConfirmRemove's confirm-remove test
    // above): the [y]es/[N]o prompt renders, and only an explicit "y" confirms via onConfigUnset —
    // Enter and any other unrecognised key both cancel back via onConfigBack.
    test("confirm-unset: '[y]es / [N]o' renders; Enter and an unrecognised key both cancel, 'y' confirms", async () => {
      const unset: string[] = [];
      const backCalls: number[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onConfigUnset={(key) => unset.push(key)}
          onConfigBack={() => backCalls.push(backCalls.length)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      dispatch({
        type: "config-step",
        state: { step: "confirm-unset", key: "SERI_VERIFY_COMMAND" },
      });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("[y]es");
      expect(frame).toContain("[N]o");
      expect(frame).toContain("Verify command (SERI_VERIFY_COMMAND)");

      instance.stdin.write("z"); // unrecognised key
      await flush();
      expect(unset).toEqual([]);
      expect(backCalls).toEqual([0]);

      dispatch({
        type: "config-step",
        state: { step: "confirm-unset", key: "SERI_VERIFY_COMMAND" },
      });
      await flush();
      instance.stdin.write("\r"); // Enter
      await flush();
      expect(unset).toEqual([]);
      expect(backCalls).toEqual([0, 1]);

      dispatch({
        type: "config-step",
        state: { step: "confirm-unset", key: "SERI_VERIFY_COMMAND" },
      });
      await flush();
      instance.stdin.write("y");
      await flush();

      expect(unset).toEqual(["SERI_VERIFY_COMMAND"]);
    });

    // configKeyInfo's fallback (tui/commands.ts): a key with no CONFIG_KEY_INFO entry shows its
    // raw name as the label, since there is no human name for it — the confirm-unset prompt above
    // only ever exercises a known key, which alone doesn't cover this path.
    test("confirm-unset on an unrecognised key shows the raw key as its own label", async () => {
      const { instance, dispatch } = await connect();

      dispatch({
        type: "config-step",
        state: { step: "confirm-unset", key: "SERI_SOME_OTHER_KEY" },
      });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("Unset SERI_SOME_OTHER_KEY (SERI_SOME_OTHER_KEY)");
    });

    // Same regression guard as the permissions panel's own truncation test below.
    test("a row count past the window budget truncates and shows a +N more footer", async () => {
      const { instance, dispatch } = await connect();

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
      await flush();

      const frame = instance.lastFrame() ?? "";
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
      const { instance, dispatch } = await connect();

      const rows = Array.from({ length: 15 }, (_, i) => ({
        key: `FAKE_KEY_${i}`,
        masked: "",
        source: "unset" as const,
        removable: false,
        kind: "string" as const,
      }));
      dispatch({ type: "config-step", state: { step: "list", rows, selected: 12 } });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("> FAKE_KEY_12");
    });

    // Regression guard: `remaining` used to be `rows.length - visible.length`, which counts rows
    // hidden ABOVE the window too and stays flat at `rows.length - windowSize` for as long as the
    // window is full — the footer never counted down while scrolling toward the bottom, and never
    // reached 0 even once every remaining row was on screen.
    test("the +N more footer count decreases while scrolling down, reaching 0 at the bottom", async () => {
      const { instance, dispatch } = await connect();

      const rows = Array.from({ length: 15 }, (_, i) => ({
        key: `FAKE_KEY_${i}`,
        masked: "",
        source: "unset" as const,
        removable: false,
        kind: "string" as const,
      }));
      dispatch({ type: "config-requested", rows });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("+5 more");

      for (let i = 0; i < 14; i++) {
        instance.stdin.write("\x1b[B"); // Down
        await flush();
      }

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("> FAKE_KEY_14");
      expect(frame).not.toContain("+0 more");
      expect(frame).not.toMatch(/\+\d+ more/);
    });

    // Regression guard: `windowSize` is recomputed live from useWindowSize().rows on every render,
    // but `offset` previously only changed via an explicit arrow press (onSelectionMove) — a
    // terminal resize that shrinks windowSize could leave the currently selected row outside
    // [offset, offset + windowSize) with no keypress to trigger a recompute. ink-testing-library's
    // own Stdout stub has no real `rows` getter (only `columns` is fixed), so it can be assigned
    // directly and a "resize" event emitted to make useWindowSize (both App.tsx's own call and
    // useListWindow's) pick up the new value, the same mechanism a real terminal resize uses.
    test("a windowSize shrink after a selection move keeps the selected row in view without a keypress", async () => {
      const { instance, dispatch } = await connect();

      const rows = Array.from({ length: 15 }, (_, i) => ({
        key: `FAKE_KEY_${i}`,
        masked: "",
        source: "unset" as const,
        removable: false,
        kind: "string" as const,
      }));
      dispatch({ type: "config-requested", rows });
      await flush();

      // Select row 9 — still inside the default (10-row) window, so offset stays 0.
      for (let i = 0; i < 9; i++) {
        instance.stdin.write("\x1b[B"); // Down
        await flush();
      }
      expect(instance.lastFrame() ?? "").toContain("> FAKE_KEY_9");

      // Shrink to a 3-row window (listWindowSize(11) = clamp(11 - 8, 3, 10) = 3) — with offset
      // still 0, row 9 would fall outside [0, 3) unless something re-clamps it.
      // @ts-expect-error — ink-testing-library's Stdout stub has no `rows` getter, so this is a
      // plain assignment, not overriding one; that's what makes the fake resize below observable.
      instance.stdout.rows = 11;
      instance.stdout.emit("resize");
      await flush();

      expect(instance.lastFrame() ?? "").toContain("> FAKE_KEY_9");
    });
  });

  describe("permissions panel", () => {
    test("a removable: false row does not show a remove affordance in the frame", async () => {
      const { instance, dispatch } = await connect();

      dispatch({
        type: "permissions-requested",
        rows: [{ tool: "read_file", source: "pre-approved", removable: false }],
      });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("read_file");
      expect(frame).toContain("not removable");
    });

    test("a removable: true row shows normally, without the not-removable note", async () => {
      const { instance, dispatch } = await connect();

      dispatch({
        type: "permissions-requested",
        rows: [{ tool: "write_file", source: "persisted", removable: true }],
      });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("write_file");
      expect(frame).not.toContain("not removable");
    });

    // Review round 3 finding (MEDIUM-1's own test coverage gap), mirroring SetupPanel's own
    // confirm-remove test above: proves App.tsx's render call actually threads onPermissionsRemove
    // through to PermissionsPanel, not just that PermissionsConfirmRemove's own 'y' handling works.
    test("confirm-remove: 'y' calls onPermissionsRemove", async () => {
      const removed: string[] = [];
      let dispatch: ((action: TuiAction) => void) | undefined;
      const instance = render(
        <App
          session={session()}
          route={route()}
          connectDispatch={(d) => (dispatch = d)}
          onPermissionsRemove={(tool) => removed.push(tool)}
          done={false}
        />,
      );
      await flush();
      if (dispatch === undefined) throw new Error("connectDispatch never fired");

      // A single dispatch straight to confirm-remove (matching SetupPanel's own confirm-remove
      // test above), not permissions-requested then permissions-step: the latter swaps
      // PermissionsList for PermissionsConfirmRemove mid-test, and that component swap's own
      // useInput needs an extra tick to register (the same mount-timing gap SetupEnterKey's own
      // key-leak test already needed two flush() calls for).
      dispatch({
        type: "permissions-step",
        state: { step: "confirm-remove", tool: "write_file" },
      });
      await flush();

      instance.stdin.write("y");
      await flush();

      expect(removed).toEqual(["write_file"]);
    });

    // useListWindow's own window budget (listWindowSize) — 15 rows, more than any real terminal's
    // clamped window under ink-testing-library (LIST_WINDOW_MAX, format.ts's own comment), so this
    // must truncate and show the footer.
    test("a row count past the window budget truncates and shows a +N more footer", async () => {
      const { instance, dispatch } = await connect();

      dispatch({
        type: "permissions-requested",
        rows: Array.from({ length: 15 }, (_, i) => ({
          tool: `tool_${i}`,
          source: "persisted" as const,
          removable: true,
        })),
      });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("tool_0");
      expect(frame).not.toContain("tool_14");
      expect(frame).toMatch(/\+\d+ more/);
    });

    // Regression guard: `remaining` used to be `rows.length - visible.length`, which counts rows
    // hidden ABOVE the window too and stays flat at `rows.length - windowSize` for as long as the
    // window is full — the footer never counted down while scrolling toward the bottom, and never
    // reached 0 even once every remaining row was on screen.
    test("the +N more footer count decreases while scrolling down, reaching 0 at the bottom", async () => {
      const { instance, dispatch } = await connect();

      dispatch({
        type: "permissions-requested",
        rows: Array.from({ length: 15 }, (_, i) => ({
          tool: `tool_${i}`,
          source: "persisted" as const,
          removable: true,
        })),
      });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("+5 more");

      for (let i = 0; i < 14; i++) {
        instance.stdin.write("\x1b[B"); // Down
        await flush();
      }

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("> tool_14");
      expect(frame).not.toMatch(/\+\d+ more/);
    });
  });

  // Render-ternary precedence (App.tsx's own comment): pendingApproval → pendingModelPicker →
  // pendingSetup → pendingAuth → pendingConfig → pendingPermissions → InputBox. Each test below
  // seeds one adjacent pair at once and checks the earlier-in-the-chain branch wins, extending the
  // existing pendingSetup-vs-InputBox precedence test above to the three new Stage A branches.
  describe("render precedence: pendingApproval / pendingSetup / pendingAuth / pendingConfig / pendingPermissions", () => {
    test("pendingApproval wins over pendingAuth", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "auth-requested", mode: "login" });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("Starting login");

      dispatch({
        type: "approval-requested",
        toolName: "write_file",
        args: {},
        offersAlways: true,
      });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("Approve write_file");
      expect(frame).not.toContain("Starting login");
    });

    test("pendingSetup wins over pendingAuth", async () => {
      const { instance, dispatch } = await connect();

      dispatch({ type: "auth-requested", mode: "login" });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("Starting login");

      dispatch({ type: "setup-requested", rows: [] });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("/setup — provider API keys");
      expect(frame).not.toContain("Starting login");
    });

    test("pendingAuth wins over pendingConfig", async () => {
      const { instance, dispatch } = await connect();

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
      await flush();
      expect(instance.lastFrame() ?? "").toContain("/config — settings");

      dispatch({ type: "auth-requested", mode: "login" });
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("Starting login");
      expect(frame).not.toContain("/config — settings");
    });

    test("pendingConfig wins over pendingPermissions", async () => {
      const { instance, dispatch } = await connect();

      dispatch({
        type: "permissions-requested",
        rows: [{ tool: "write_file", source: "persisted", removable: true }],
      });
      await flush();
      expect(instance.lastFrame() ?? "").toContain("/permissions — tools approved permanently");

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
      await flush();

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("/config — settings");
      expect(frame).not.toContain("/permissions — tools approved permanently");
    });
  });
});
