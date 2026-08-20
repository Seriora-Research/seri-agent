import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntry } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import type { LoopEvent } from "../../src/loop/loop";
import type { SessionState } from "../../src/session/session";
import type {
  ConfigRow,
  ModelPickerEntry,
  PermissionRow,
  SetupProviderRow,
} from "../../src/tui/commands";
import { visibleTranscript, wrapPendingRows } from "../../src/tui/format";
import { initialTuiState, tuiReducer, type TuiState } from "../../src/tui/reducer";

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

describe("initialTuiState", () => {
  test("starts with an empty transcript and a mode indicator matching the session", () => {
    const state = initialTuiState(session({ permissionMode: "read-only" }));

    expect(state.transcript).toEqual([]);
    expect(state.streaming).toBe("");
    expect(state.modeIndicator).toBe("[read-only]");
  });
});

describe("tuiReducer: session-updated", () => {
  test("replaces the session and refreshes the mode indicator", () => {
    const state = initialTuiState(session({ permissionMode: "read-only" }));
    const next = tuiReducer(state, {
      type: "session-updated",
      session: session({ permissionMode: "auto" }),
    });

    expect(next.session.permissionMode).toBe("auto");
    expect(next.modeIndicator).toBe("[auto]");
  });
});

describe("tuiReducer: transcript-append", () => {
  test("appends a line without touching the session", () => {
    const state = initialTuiState(session());
    const next = tuiReducer(state, {
      type: "transcript-append",
      line: "Session s1: permission mode is now auto",
    });

    expect(next.transcript).toEqual([
      { role: "system", text: "Session s1: permission mode is now auto" },
    ]);
    expect(next.session).toBe(state.session);
  });

  // Regression guard: transcript-append used to be a bare append (`{ ...state, transcript:
  // [...state.transcript, action.line] }`), unlike every other transcript-writing case, which
  // all go through pushLine and flush state.streaming first. Harmless while transcript-append had
  // no real callers mid-stream, but tuiPresenter.message, undoPlanLines/recoveryLines, and quit()'s
  // own "quitting - cancelling..." line all dispatch it now, and the last of those can fire WHILE
  // a turn is still streaming text (a /mode or /exit typed mid-answer) — a bare append would leave
  // the partial answer sitting in `streaming`, appended later, AFTER the transcript-append line,
  // reordering the transcript against what the model actually said first. The test above alone
  // does not catch this: initialTuiState's own streaming is already "", so a bare append and
  // pushLine produce identical results there. Verified: reverting transcript-append's case to the
  // bare append above and re-running this test fails it — the bare append never touches
  // `streaming` at all, so `next.streaming` stays "the streamed answer so far" (not "") and
  // `next.transcript` is only `["/mode: permission mode is now auto"]`, missing the streamed
  // text entirely rather than having it flushed first.
  test("flushes pending streamed text before the appended line, same as every other transcript-writing case", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: "the streamed answer so far" },
    });

    const next = tuiReducer(state, {
      type: "transcript-append",
      line: "/mode: permission mode is now auto",
    });

    expect(next.transcript).toEqual([
      { role: "assistant", text: "the streamed answer so far" },
      { role: "system", text: "/mode: permission mode is now auto" },
    ]);
    expect(next.streaming).toBe("");
  });

  // Design-question fix (this PR's own follow-up): echoUserInput (cli.ts) dispatches
  // transcript-append with `flush: false` for a submission REJECTED by a mid-turn gate (e.g.
  // MEDIUM-3's /rewind-while-turnInFlight check) — the model's own turn is unaffected, so echoing
  // the rejected text should not fragment its still-in-progress answer into two transcript
  // entries. `flush: false` must not touch `streaming` at all: not flush it into transcript (that
  // would still fragment the answer) and not clear it either (that would silently drop the
  // model's partial text — a worse bug than the one being fixed).
  test("flush: false appends the line without flushing OR clearing pending streamed text", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: "the model's still-in-progress answer" },
    });

    const next = tuiReducer(state, {
      type: "transcript-append",
      line: "> /rewind 1",
      flush: false,
    });

    expect(next.transcript).toEqual([{ role: "system", text: "> /rewind 1" }]);
    expect(next.streaming).toBe("the model's still-in-progress answer");
  });
});

describe("tuiReducer: transcript role tagging", () => {
  test('a role: "user" append after existing content gets a leading blank system separator', () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "transcript-append",
      line: "first",
    });
    state = tuiReducer(state, { type: "transcript-append", line: "> hello", role: "user" });

    expect(state.transcript).toEqual([
      { role: "system", text: "first" },
      { role: "system", text: "" },
      { role: "user", text: "> hello" },
    ]);
  });

  // Regression: echoUserInput (cli.ts) is the only call site that ever dispatches `role: "user"`,
  // and it always passes `flush: false` (deliberately, so a rejected/echoed submission never
  // fragments an in-progress streamed answer — see pushLine's own comment). The separator used to
  // be computed only on the `flush: true` branch, so this exact combination — the only one a real
  // user turn ever produces — silently skipped the leading blank line.
  test('role: "user", flush: false (the actual echoUserInput dispatch shape) still gets a leading blank separator', () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "transcript-append",
      line: "first",
    });
    state = tuiReducer(state, {
      type: "transcript-append",
      line: "> hello",
      role: "user",
      flush: false,
    });

    expect(state.transcript).toEqual([
      { role: "system", text: "first" },
      { role: "system", text: "" },
      { role: "user", text: "> hello" },
    ]);
  });

  test('the very first entry in a fresh session gets no leading separator, even with role: "user"', () => {
    const state = tuiReducer(initialTuiState(session()), {
      type: "transcript-append",
      line: "> hello",
      role: "user",
    });

    expect(state.transcript).toEqual([{ role: "user", text: "> hello" }]);
  });

  test('a flushed state.streaming commits as role: "assistant"', () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "loop-event",
      event: { type: "text-delta", text: "the answer" },
    });
    state = tuiReducer(state, { type: "transcript-append", line: "next" });

    expect(state.transcript).toEqual([
      { role: "assistant", text: "the answer" },
      { role: "system", text: "next" },
    ]);
  });

  test('every applyLoopEvent case lands as role: "system"', () => {
    const events: LoopEvent[] = [
      { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
      { type: "tool-result", name: "read_file", result: "ok" },
      { type: "permission-denied", name: "write_file", reason: "declined" },
      { type: "tool-allowed", name: "write_file" },
      {
        type: "compacted",
        summary: { goal: "g", progress: "p", blockers: "b", nextSteps: "n" },
        evictedCount: 3,
        usage: {
          inputTokens: 12,
          inputTokenDetails: {
            noCacheTokens: 12,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 34,
          outputTokenDetails: { textTokens: 34, reasoningTokens: undefined },
          totalTokens: 46,
        },
      },
      { type: "retry", attempt: 1 },
      { type: "done", reason: "no-tool-call" },
      { type: "error", error: "boom" },
    ];

    let state = initialTuiState(session());
    for (const event of events) {
      state = tuiReducer(state, { type: "loop-event", event });
      expect(state.transcript.at(-1)?.role).toBe("system");
    }
  });
});

describe("tuiReducer: transcript-scroll / transcript-scroll-to", () => {
  function transcriptOf(lines: string[]) {
    let state = initialTuiState(session());
    for (const line of lines) state = tuiReducer(state, { type: "transcript-append", line });
    return state;
  }

  test("a positive delta (toward older lines) increases the offset", () => {
    const state = { ...transcriptOf(["a", "b", "c", "d", "e"]), viewportRows: 1 };
    const next = tuiReducer(state, { type: "transcript-scroll", delta: 2 });
    expect(next.transcriptScrollOffset).toBe(2);
  });

  test("clamps at 0 — a negative delta cannot scroll past the newest line", () => {
    const state = { ...transcriptOf(["a", "b", "c"]), viewportRows: 1 };
    const next = tuiReducer(state, { type: "transcript-scroll", delta: -5 });
    expect(next.transcriptScrollOffset).toBe(0);
  });

  // A large delta must not scroll past the offset that shows a FULL viewport of the oldest
  // lines — `transcript.length - viewportRows`, not `transcript.length - 1` (the latter would
  // slice `visibleTranscript` down to a single oldest line pinned to the bottom by
  // `justifyContent="flex-end"`, App.tsx, instead of a full page).
  test("clamps at transcript.length - viewportRows — a large delta stops at a full page of the oldest lines", () => {
    const state = { ...transcriptOf(["a", "b", "c", "d", "e"]), viewportRows: 2 };
    const next = tuiReducer(state, { type: "transcript-scroll", delta: 100 });
    expect(next.transcriptScrollOffset).toBe(3);
  });

  test("transcript-scroll-to top jumps to the offset that shows a full page of the oldest lines", () => {
    const state = { ...transcriptOf(["a", "b", "c", "d", "e"]), viewportRows: 2 };
    const next = tuiReducer(state, { type: "transcript-scroll-to", to: "top" });
    expect(next.transcriptScrollOffset).toBe(3);
  });

  // Regression: Home/repeated PageUp used to collapse the viewport to a single line instead of
  // a full page.
  test("transcript-scroll-to top: visibleTranscript then renders a full viewport of the oldest lines, not one line", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const state = { ...transcriptOf(lines), viewportRows: 5 };
    const next = tuiReducer(state, { type: "transcript-scroll-to", to: "top" });

    const visible = visibleTranscript(
      next.transcript,
      5,
      next.transcriptScrollOffset,
      next.columns,
    );
    expect(visible).toEqual(
      ["line 0", "line 1", "line 2", "line 3", "line 4"].map((text) => ({
        role: "system",
        text,
      })),
    );
  });

  test("transcript-scroll-to bottom resumes following the newest line", () => {
    const scrolled = tuiReducer(
      { ...transcriptOf(["a", "b", "c"]), viewportRows: 1 },
      { type: "transcript-scroll", delta: 2 },
    );
    const next = tuiReducer(scrolled, { type: "transcript-scroll-to", to: "bottom" });
    expect(next.transcriptScrollOffset).toBe(0);
  });

  // reducer.ts's own anchoring rule (see its comment on `appendLines`): a scrolled-up view must
  // not slide out from under the reader as new lines land underneath it. `pushLine` can append TWO
  // lines in one call (a flushed streaming answer plus the new line, as here) — the offset has to
  // advance by however many lines actually landed, not by a hardcoded 1, or a flush-heavy sequence
  // of turns would silently drift the anchored view.
  test("a scrolled-up view (offset > 0) advances by the number of lines a flush actually appends", () => {
    let state: TuiState = { ...transcriptOf(["a", "b", "c", "d", "e"]), viewportRows: 2 };
    state = tuiReducer(state, { type: "transcript-scroll", delta: 3 });
    expect(state.transcriptScrollOffset).toBe(3);

    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: "the model's in-progress answer" },
    });
    // flush: true (the default) — pushLine commits `streaming` AND `line`, two lines in one call.
    const next = tuiReducer(state, { type: "transcript-append", line: "f" });

    expect(next.transcript).toEqual([
      { role: "system", text: "a" },
      { role: "system", text: "b" },
      { role: "system", text: "c" },
      { role: "system", text: "d" },
      { role: "system", text: "e" },
      { role: "assistant", text: "the model's in-progress answer" },
      { role: "system", text: "f" },
    ]);
    expect(next.transcriptScrollOffset).toBe(5);
  });

  test("a view already following the newest line (offset === 0) stays at 0 regardless of how many lines a flush appends", () => {
    let state = transcriptOf(["a", "b", "c"]);
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: "streaming…" },
    });
    const next = tuiReducer(state, { type: "transcript-append", line: "d" });

    expect(next.transcript).toEqual([
      { role: "system", text: "a" },
      { role: "system", text: "b" },
      { role: "system", text: "c" },
      { role: "assistant", text: "streaming…" },
      { role: "system", text: "d" },
    ]);
    expect(next.transcriptScrollOffset).toBe(0);
  });

  // Regression: `state.totalVisualRows` only ever tracks the COMMITTED transcript, so a scroll
  // bound derived from it alone stayed clamped to 0 with an empty transcript, no matter how tall
  // an in-progress streamed answer (`state.streaming`) grew — PageUp/Home could never reach rows
  // that `visibleTranscript` (format.ts) was already rendering above the viewport's tail.
  test("transcript-scroll-to top reaches rows still sitting in an in-progress streamed answer, not just the committed transcript", () => {
    const streamingLines = Array.from({ length: 20 }, (_, i) => `streamed line ${i}`);
    let state: TuiState = { ...initialTuiState(session()), viewportRows: 5 };
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: streamingLines.join("\n") },
    });

    const next = tuiReducer(state, { type: "transcript-scroll-to", to: "top" });
    expect(next.transcriptScrollOffset).toBe(15);

    const visible = visibleTranscript(
      next.transcript,
      5,
      next.transcriptScrollOffset,
      next.columns,
      wrapPendingRows(next.streaming, next.columns),
    );
    // The `●` marker (format.ts's own displayText) is prefixed once, onto the very first VISUAL
    // row of the whole streamed answer, not onto every wrapped line within it.
    expect(visible).toEqual(
      streamingLines
        .slice(0, 5)
        .map((text, i) => ({ role: "assistant", text: i === 0 ? `● ${text}` : text })),
    );
  });

  // `transcriptScrollStreamingRows` snapshots the streaming row count already folded into
  // `transcriptScrollOffset` by `maxScrollOffset` above — App.tsx (its own `pendingRows`
  // compensation) reads this back to add only newly-streamed growth on top of the offset, not the
  // full current streaming row count again. `state.streaming` hasn't grown since the dispatch
  // above, so the snapshot must equal the same 20 rows already baked into `transcriptScrollOffset`.
  test("transcript-scroll-to top snapshots the streaming row count already baked into the offset", () => {
    const streamingLines = Array.from({ length: 20 }, (_, i) => `streamed line ${i}`);
    let state: TuiState = { ...initialTuiState(session()), viewportRows: 5 };
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: streamingLines.join("\n") },
    });

    const next = tuiReducer(state, { type: "transcript-scroll-to", to: "top" });
    expect(next.transcriptScrollOffset).toBe(15);
    expect(next.transcriptScrollStreamingRows).toBe(20);
  });

  // Regression: appendLines used to add a flush's FULL added-row count to `transcriptScrollOffset`
  // even though `transcriptScrollStreamingRows` rows of that streaming text were already folded
  // into the offset once, by the earlier `transcript-scroll-to`. Streaming another 5 rows after
  // that snapshot (still un-flushed, so the offset doesn't move again) and then flushing counted
  // those original 20 rows a second time, overshooting the correct anchor by exactly 20 rows and
  // landing past the end of the transcript — `visibleTranscript` at that offset returns nothing.
  test("a flush after more streaming happened since a scroll snapshot advances the offset only by the newly-flushed growth, not the full streamed length again", () => {
    const streamingLines = Array.from({ length: 20 }, (_, i) => `streamed line ${i}`);
    let state: TuiState = { ...initialTuiState(session()), viewportRows: 5 };
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: streamingLines.join("\n") },
    });
    state = tuiReducer(state, { type: "transcript-scroll-to", to: "top" });
    expect(state.transcriptScrollOffset).toBe(15);
    expect(state.transcriptScrollStreamingRows).toBe(20);

    const moreLines = Array.from({ length: 5 }, (_, i) => `streamed line ${20 + i}`);
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: `\n${moreLines.join("\n")}` },
    });

    const next = tuiReducer(state, { type: "transcript-append", line: "(done: no-tool-call)" });

    expect(next.transcriptScrollOffset).toBe(21);
    const visible = visibleTranscript(
      next.transcript,
      5,
      next.transcriptScrollOffset,
      next.columns,
    );
    expect(visible).toEqual(
      streamingLines
        .slice(0, 5)
        .map((text, i) => ({ role: "assistant", text: i === 0 ? `● ${text}` : text })),
    );
  });

  // `flush: false` (echoUserInput echoing a submission a mid-turn gate rejected — see
  // transcript-append's own case comment) never resolves `state.streaming`: nothing moves out of
  // it into `rawLines`, so the still-active streaming answer's own snapshot must stay exactly as
  // the last real scroll action left it, not get reset as if this append had flushed it.
  test("flush: false leaves transcriptScrollStreamingRows untouched — the streaming answer it snapshot is still in progress", () => {
    const streamingLines = Array.from({ length: 20 }, (_, i) => `streamed line ${i}`);
    let state: TuiState = { ...initialTuiState(session()), viewportRows: 5 };
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: streamingLines.join("\n") },
    });
    state = tuiReducer(state, { type: "transcript-scroll-to", to: "top" });
    expect(state.transcriptScrollStreamingRows).toBe(20);

    const next = tuiReducer(state, {
      type: "transcript-append",
      line: "> /rewind 1",
      flush: false,
    });

    expect(next.transcriptScrollStreamingRows).toBe(20);
    expect(next.streaming).toBe(streamingLines.join("\n"));
  });

  // Regression guard: `transcript` stores LOGICAL lines, never pre-wrapped output — a multi-line
  // string committed by one `transcript-append` must stay exactly one array entry, not several.
  // Storing the wrapped form instead was tried and reverted: once written, a hard-wrap break is
  // indistinguishable from a real `\n`, so a later resize could never correctly re-wrap it.
  test("transcript-append stores one entry per call, even for a multi-line string", () => {
    const state = initialTuiState(session());
    const next = tuiReducer(state, {
      type: "transcript-append",
      line: "first line\nsecond line\nthird line",
    });

    expect(next.transcript).toEqual([
      { role: "system", text: "first line\nsecond line\nthird line" },
    ]);
  });
});

describe("tuiReducer: viewport-resized", () => {
  test("updates columns and viewportRows", () => {
    const state = initialTuiState(session());
    const next = tuiReducer(state, { type: "viewport-resized", columns: 60, viewportRows: 12 });

    expect(next.columns).toBe(60);
    expect(next.viewportRows).toBe(12);
  });

  // The bug this action's own re-clamp exists to close: a resize that GROWS viewportRows (a taller
  // terminal) shrinks the max valid offset (`totalRows - viewportRows`), which can leave a
  // previously-valid `transcriptScrollOffset` past the new maximum.
  test("re-clamps transcriptScrollOffset when a growing viewportRows makes it invalid", () => {
    let state = initialTuiState(session());
    for (let i = 0; i < 10; i++) {
      state = tuiReducer(state, { type: "transcript-append", line: `line ${i}` });
    }
    state = { ...state, viewportRows: 3 };
    state = tuiReducer(state, { type: "transcript-scroll-to", to: "top" });
    expect(state.transcriptScrollOffset).toBe(7); // 10 rows - 3 viewportRows

    const next = tuiReducer(state, { type: "viewport-resized", columns: 80, viewportRows: 8 });
    expect(next.transcriptScrollOffset).toBe(2); // 10 rows - 8 viewportRows
  });

  // Regression guard (found by review): the transcript used to hard-wrap AT WRITE TIME, so a
  // narrowing resize left already-committed entries wrapped at the OLD width forever — the exact
  // "one entry doesn't equal one visual row" bug this file exists to close, just re-entered through
  // the resize door instead of through a long append. Storing logical lines and deriving visual rows
  // on read (transcriptVisualRows, format.ts) means a resize can only ever change how MANY rows the
  // clamp reports, never lose the ability to reach any of them.
  test("a narrowing resize re-derives the total row count instead of trusting stale wrapped output", () => {
    const long = "a".repeat(200); // 200 chars, no spaces — always hard-wraps, at any width
    let state = tuiReducer(initialTuiState(session()), { type: "transcript-append", line: long });
    state = tuiReducer(state, { type: "viewport-resized", columns: 100, viewportRows: 5 });
    state = tuiReducer(state, { type: "transcript-scroll-to", to: "top" });
    const offsetAt100Cols = state.transcriptScrollOffset; // 2 rows at 100 cols, minus 5 viewportRows

    // Narrow to 20 columns: the SAME logical entry now needs far more visual rows (10, not 2) — a
    // write-time-wrapped design would still report the OLD row count here and under-clamp.
    const narrowed = tuiReducer(state, { type: "viewport-resized", columns: 20, viewportRows: 5 });
    const reClamped = tuiReducer(narrowed, { type: "transcript-scroll-to", to: "top" });

    expect(reClamped.transcriptScrollOffset).toBeGreaterThan(offsetAt100Cols);
    expect(reClamped.transcriptScrollOffset).toBe(5); // 10 rows at 20 cols, minus 5 viewportRows
  });
});

describe("tuiReducer: loop-event", () => {
  function apply(state = initialTuiState(session()), event: LoopEvent) {
    return tuiReducer(state, { type: "loop-event", event });
  }

  test("text-delta accumulates into the streaming buffer, not the transcript", () => {
    let state = apply(undefined, { type: "text-delta", text: "Hel" });
    state = apply(state, { type: "text-delta", text: "lo" });

    expect(state.streaming).toBe("Hello");
    expect(state.transcript).toEqual([]);
  });

  test("a tool-call flushes pending streamed text and sets a running status", () => {
    let state = apply(undefined, { type: "text-delta", text: "thinking…" });
    state = apply(state, { type: "tool-call", name: "read_file", args: { path: "a.txt" } });

    expect(state.transcript).toEqual([
      { role: "assistant", text: "thinking…" },
      { role: "system", text: `→ read_file({"path":"a.txt"})` },
    ]);
    expect(state.streaming).toBe("");
    expect(state.status).toBe("Running read_file…");
  });

  test("a tool-result clears the running status", () => {
    let state = apply(undefined, { type: "tool-call", name: "read_file", args: {} });
    state = apply(state, { type: "tool-result", name: "read_file", result: "ok" });

    expect(state.status).toBe("");
    expect(state.transcript.at(-1)).toEqual({ role: "system", text: "✓ read_file done" });
  });

  test("permission-denied and tool-allowed each append their own line", () => {
    let state = apply(undefined, {
      type: "permission-denied",
      name: "write_file",
      reason: "declined",
    });
    expect(state.transcript.at(-1)).toEqual({ role: "system", text: "✗ write_file blocked" });

    state = apply(state, { type: "tool-allowed", name: "write_file" });
    expect(state.transcript.at(-1)).toEqual({
      role: "system",
      text: "✓ write_file approved for the rest of this run",
    });
  });

  test("done flushes streamed text, reports the reason, and clears status", () => {
    let state = apply(undefined, { type: "text-delta", text: "the answer" });
    state = apply(state, { type: "done", reason: "no-tool-call" });

    expect(state.transcript).toEqual([
      { role: "assistant", text: "the answer" },
      { role: "system", text: "(done: no-tool-call)" },
    ]);
    expect(state.streaming).toBe("");
    expect(state.status).toBe("");
  });

  test("messages-updated is a no-op on the transcript", () => {
    const state = apply(undefined, { type: "messages-updated", messages: [] });

    expect(state.transcript).toEqual([]);
    expect(state.streaming).toBe("");
  });

  // C-1 (regression): driveLoop used to compute the messages-updated merge itself, from a
  // `session` variable it closed over once at the start of a turn — so a mid-run /mode dispatched
  // its own fresh session-updated action, and the very next messages-updated event silently
  // reverted it, both in the reducer and (since driveLoop's own saveSession call used the same
  // stale variable) on disk. Fixed by having the reducer do this merge itself, against its OWN
  // current `state.session` — this test is the regression guard for that: it dispatches a
  // session-updated (the same shape a mid-run /mode produces) and THEN a messages-updated, and
  // would have failed against the pre-fix reducer, which treated messages-updated as a no-op on
  // `session` entirely (verified: reverting this file's messages-updated case to `return state;`
  // and re-running this test fails it — the assertion below then sees the ORIGINAL
  // "approve-each" mode, not "read-only").
  test("messages-updated merges into the CURRENT session, not a stale one dispatched earlier", () => {
    let state = initialTuiState(session({ permissionMode: "approve-each" }));
    // A mid-run /mode: the same action tuiPresenter.sessionUpdated dispatches.
    state = tuiReducer(state, {
      type: "session-updated",
      session: session({ permissionMode: "read-only" }),
    });
    // driveLoop's own report of the turn's next messages-updated event.
    state = apply(state, {
      type: "messages-updated",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(state.session.permissionMode).toBe("read-only");
    expect(state.session.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

// Findings 1+5 (thermo-nuclear structural review, round 6): the TUI-native ApprovalPrompt's own
// state, set/cleared by runTui's tuiApprovalPrompt/onApprovalAnswer.
describe("tuiReducer: approval-requested / approval-resolved", () => {
  test("approval-requested sets pendingApproval, approval-resolved clears it", () => {
    let state = initialTuiState(session());
    expect(state.pendingApproval).toBeUndefined();

    state = tuiReducer(state, {
      type: "approval-requested",
      toolName: "write_file",
      args: { path: "a.txt", content: "x" },
      offersAlways: true,
    });
    expect(state.pendingApproval).toEqual({
      toolName: "write_file",
      args: { path: "a.txt", content: "x" },
      offersAlways: true,
    });

    state = tuiReducer(state, { type: "approval-resolved" });
    expect(state.pendingApproval).toBeUndefined();
  });
});

describe("tuiReducer: command-error / command-error-cleared", () => {
  test("command-error sets commandError, command-error-cleared clears it, other fields untouched", () => {
    const initial = initialTuiState(session());
    expect(initial.commandError).toBeUndefined();

    const withError = tuiReducer(initial, {
      type: "command-error",
      message: "Usage: /profile new <name>",
    });
    expect(withError.commandError).toBe("Usage: /profile new <name>");

    const cleared = tuiReducer(withError, { type: "command-error-cleared" });
    expect(cleared.commandError).toBeUndefined();
    expect(cleared.session).toBe(withError.session);
    expect(cleared.transcript).toBe(withError.transcript);
  });
});

describe("tuiReducer: model-picker-requested / model-picker-resolved", () => {
  const entry: ModelCatalogEntry = {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    displayName: "Llama 3.3 70B",
    family: "llama",
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    toolCall: true,
    reasoning: false,
    pricing: undefined,
  };
  const row: ModelPickerEntry = {
    entry,
    keyConfigured: true,
    alternatives: 0,
    gatewayReachable: false,
  };

  test("model-picker-requested sets pendingModelPicker", () => {
    const state = tuiReducer(initialTuiState(session()), {
      type: "model-picker-requested",
      entries: [row],
    });

    expect(state.pendingModelPicker).toEqual({ entries: [row] });
  });

  test("model-picker-resolved with a pick merges model/provider into state.session and clears the picker in the same dispatch", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "model-picker-requested",
      entries: [row],
    });

    state = tuiReducer(state, {
      type: "model-picker-resolved",
      pick: { model: entry.id, provider: entry.provider, keyConfigured: true },
    });

    expect(state.pendingModelPicker).toBeUndefined();
    expect(state.session).toEqual(session({ model: entry.id, provider: entry.provider }));
  });

  // B4/MEDIUM-4: the bug this closes. `model-picker-resolved` used to carry a whole SessionState
  // captured when the picker rendered and replace `state.session` wholesale with it — so a
  // `messages-updated` landing while the picker was still open (the picker can open mid-turn, see
  // pendingModelPicker's own comment) got silently reverted the moment the pick resolved. Merging
  // just the pick into whatever `state.session` actually is AT RESOLUTION TIME is what fixes it —
  // this asserts the merge lands on top of a session newer than the one the picker was opened with.
  test("model-picker-resolved merges into the CURRENT session, not a stale one captured when the picker opened", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "model-picker-requested",
      entries: [row],
    });
    // Simulates a turn's own messages-updated event landing while the picker is still open.
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "messages-updated", messages: [{ role: "user", content: "hi" }] },
    });

    state = tuiReducer(state, {
      type: "model-picker-resolved",
      pick: { model: entry.id, provider: entry.provider, keyConfigured: true },
    });

    expect(state.session.model).toBe(entry.id);
    expect(state.session.provider).toBe(entry.provider);
    expect(state.session.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("model-picker-resolved with no pick only clears the picker", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "model-picker-requested",
      entries: [row],
    });
    const before = state.session;

    state = tuiReducer(state, { type: "model-picker-resolved" });

    expect(state.pendingModelPicker).toBeUndefined();
    expect(state.session).toBe(before);
  });

  // Code-review finding: a combined pty chunk carrying filter text, a terminator, AND further
  // characters used to just discard everything after the terminator when the picker closed —
  // dropped keystrokes with no trace. leftoverInput is how App.tsx's ModelPicker hands that text
  // back; pendingInputPrefill is where the reducer parks it for InputBox's very next mount.
  test("model-picker-resolved with leftoverInput sets pendingInputPrefill", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "model-picker-requested",
      entries: [row],
    });

    state = tuiReducer(state, {
      type: "model-picker-resolved",
      pick: { model: entry.id, provider: entry.provider, keyConfigured: true },
      leftoverInput: "another query",
    });

    expect(state.pendingInputPrefill).toBe("another query");
    expect(state.session.model).toBe(entry.id);
  });

  test("model-picker-resolved without leftoverInput leaves pendingInputPrefill undefined", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "model-picker-requested",
      entries: [row],
    });

    state = tuiReducer(state, {
      type: "model-picker-resolved",
      pick: { model: entry.id, provider: entry.provider, keyConfigured: true },
    });

    expect(state.pendingInputPrefill).toBeUndefined();
  });

  test("input-prefill-consumed clears pendingInputPrefill", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "model-picker-requested",
      entries: [row],
    });
    state = tuiReducer(state, {
      type: "model-picker-resolved",
      pick: { model: entry.id, provider: entry.provider, keyConfigured: true },
      leftoverInput: "another query",
    });
    expect(state.pendingInputPrefill).toBe("another query");

    state = tuiReducer(state, { type: "input-prefill-consumed" });

    expect(state.pendingInputPrefill).toBeUndefined();
    // Consuming the prefill must not disturb the session the same dispatch already landed.
    expect(state.session.model).toBe(entry.id);
  });
});

describe("tuiReducer: setup-requested / setup-step / setup-resolved", () => {
  const rows: SetupProviderRow[] = [
    {
      provider: "groq",
      keyName: "GROQ_API_KEY",
      source: "unset",
      masked: undefined,
      removable: false,
    },
  ];

  test("setup-requested opens at step list with the given rows", () => {
    const state = tuiReducer(initialTuiState(session()), { type: "setup-requested", rows });

    expect(state.pendingSetup).toEqual({ step: "list", rows, selected: 0 });
  });

  test("setup-step transitions to a new step", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "setup-requested", rows });

    state = tuiReducer(state, {
      type: "setup-step",
      state: { step: "enter-key", provider: "groq", keyName: "GROQ_API_KEY", busy: false },
    });

    expect(state.pendingSetup).toEqual({
      step: "enter-key",
      provider: "groq",
      keyName: "GROQ_API_KEY",
      busy: false,
    });
  });

  test("setup-resolved clears pendingSetup and carries leftoverInput into pendingInputPrefill", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "setup-requested", rows });

    state = tuiReducer(state, { type: "setup-resolved", leftoverInput: "typed after close" });

    expect(state.pendingSetup).toBeUndefined();
    expect(state.pendingInputPrefill).toBe("typed after close");
  });

  test("setup-resolved without leftoverInput leaves pendingInputPrefill undefined", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "setup-requested", rows });

    state = tuiReducer(state, { type: "setup-resolved" });

    expect(state.pendingSetup).toBeUndefined();
    expect(state.pendingInputPrefill).toBeUndefined();
  });

  // pendingApproval/pendingModelPicker already coexist deliberately (reducer.ts's own comment on
  // pendingModelPicker) — pendingSetup joins that same set of independent fields, not a
  // fourth mutually-exclusive flag the reducer itself enforces (App.tsx's render ternary is what
  // picks one to actually show).
  test("pendingSetup and pendingModelPicker can both be set without either clobbering the other", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "setup-requested", rows });
    state = tuiReducer(state, { type: "model-picker-requested", entries: [] });

    expect(state.pendingSetup).toEqual({ step: "list", rows, selected: 0 });
    expect(state.pendingModelPicker).toEqual({ entries: [] });
  });
});

// Stage A scaffolding (cli-commands-to-tui feature-plan.md): these ten actions have no dispatcher
// yet — Stages B-D wire /login, /signup, /config and /permissions to fire them. Each case below
// asserts the WHOLE resulting state against `{ ...initialTuiState(session()), ...expected }`, not
// just the touched field, so a future change that leaks into an unrelated field (the same class of
// bug pendingSetup's own coexistence test above guards against) fails here too.
describe("tuiReducer: auth-offer / auth-requested / auth-step / auth-resolved", () => {
  test("auth-offer sets authOffer without touching pendingAuth", () => {
    const state = tuiReducer(initialTuiState(session()), { type: "auth-offer", show: true });

    expect(state).toEqual({ ...initialTuiState(session()), authOffer: true });
  });

  test("auth-offer: false does not clear an already-set pendingAuth", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "auth-requested",
      mode: "login",
    });
    state = tuiReducer(state, { type: "auth-offer", show: false });

    expect(state).toEqual({
      ...initialTuiState(session()),
      authOffer: false,
      pendingAuth: { step: "starting", mode: "login" },
    });
  });

  test("auth-requested opens at step starting with the given mode", () => {
    const state = tuiReducer(initialTuiState(session()), {
      type: "auth-requested",
      mode: "signup",
    });

    expect(state).toEqual({
      ...initialTuiState(session()),
      pendingAuth: { step: "starting", mode: "signup" },
    });
  });

  test("auth-step transitions to a new step", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "auth-requested", mode: "login" });

    state = tuiReducer(state, {
      type: "auth-step",
      state: { step: "device", mode: "login", verificationUri: "https://x", userCode: "AB-12" },
    });

    expect(state).toEqual({
      ...initialTuiState(session()),
      pendingAuth: {
        step: "device",
        mode: "login",
        verificationUri: "https://x",
        userCode: "AB-12",
      },
    });
  });

  test("auth-resolved clears pendingAuth and carries leftoverInput into pendingInputPrefill", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "auth-requested", mode: "login" });

    state = tuiReducer(state, { type: "auth-resolved", leftoverInput: "typed after close" });

    expect(state).toEqual({
      ...initialTuiState(session()),
      pendingInputPrefill: "typed after close",
    });
  });

  test("auth-resolved without leftoverInput leaves pendingInputPrefill undefined", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "auth-requested", mode: "login" });

    state = tuiReducer(state, { type: "auth-resolved" });

    expect(state).toEqual(initialTuiState(session()));
  });
});

describe("tuiReducer: config-requested / config-step / config-resolved", () => {
  const rows: ConfigRow[] = [
    {
      key: "SERI_VERIFY_ENABLED",
      masked: "",
      source: "unset",
      removable: false,
      kind: "boolean",
      on: true,
    },
  ];

  test("config-requested opens at step list with the given rows", () => {
    const state = tuiReducer(initialTuiState(session()), { type: "config-requested", rows });

    expect(state).toEqual({
      ...initialTuiState(session()),
      pendingConfig: { step: "list", rows, selected: 0 },
    });
  });

  test("config-step transitions to a new step", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "config-requested", rows });

    state = tuiReducer(state, {
      type: "config-step",
      state: { step: "enter-value", key: "SERI_VERIFY_ENABLED", busy: false },
    });

    expect(state).toEqual({
      ...initialTuiState(session()),
      pendingConfig: { step: "enter-value", key: "SERI_VERIFY_ENABLED", busy: false },
    });
  });

  test("config-resolved clears pendingConfig and carries leftoverInput into pendingInputPrefill", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "config-requested", rows });

    state = tuiReducer(state, { type: "config-resolved", leftoverInput: "typed after close" });

    expect(state).toEqual({
      ...initialTuiState(session()),
      pendingInputPrefill: "typed after close",
    });
  });

  test("config-resolved without leftoverInput leaves pendingInputPrefill undefined", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "config-requested", rows });

    state = tuiReducer(state, { type: "config-resolved" });

    expect(state).toEqual(initialTuiState(session()));
  });
});

describe("tuiReducer: permissions-requested / permissions-step / permissions-resolved", () => {
  const rows: PermissionRow[] = [{ tool: "write_file", source: "persisted", removable: true }];

  test("permissions-requested opens at step list with the given rows", () => {
    const state = tuiReducer(initialTuiState(session()), {
      type: "permissions-requested",
      rows,
    });

    expect(state).toEqual({
      ...initialTuiState(session()),
      pendingPermissions: { step: "list", rows, selected: 0 },
    });
  });

  test("permissions-step transitions to a new step", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "permissions-requested", rows });

    state = tuiReducer(state, {
      type: "permissions-step",
      state: { step: "confirm-remove", tool: "write_file" },
    });

    expect(state).toEqual({
      ...initialTuiState(session()),
      pendingPermissions: { step: "confirm-remove", tool: "write_file" },
    });
  });

  test("permissions-resolved clears pendingPermissions and carries leftoverInput into pendingInputPrefill", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "permissions-requested", rows });

    state = tuiReducer(state, {
      type: "permissions-resolved",
      leftoverInput: "typed after close",
    });

    expect(state).toEqual({
      ...initialTuiState(session()),
      pendingInputPrefill: "typed after close",
    });
  });

  test("permissions-resolved without leftoverInput leaves pendingInputPrefill undefined", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "permissions-requested", rows });

    state = tuiReducer(state, { type: "permissions-resolved" });

    expect(state).toEqual(initialTuiState(session()));
  });
});

describe("tuiReducer: splash-requested / splash-resolved", () => {
  test("initialTuiState without opts defaults pendingSplash to false", () => {
    expect(initialTuiState(session()).pendingSplash).toBe(false);
  });

  test("initialTuiState with showSplash: true sets pendingSplash to true", () => {
    expect(initialTuiState(session(), { showSplash: true }).pendingSplash).toBe(true);
  });

  test("splash-requested sets pendingSplash to true from a default-false state", () => {
    const state = tuiReducer(initialTuiState(session()), { type: "splash-requested" });

    expect(state).toEqual({ ...initialTuiState(session()), pendingSplash: true });
  });

  test("splash-resolved clears pendingSplash and leaves every other field untouched", () => {
    const state = tuiReducer(initialTuiState(session(), { showSplash: true }), {
      type: "splash-resolved",
    });

    expect(state).toEqual(initialTuiState(session()));
  });
});
