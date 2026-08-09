import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import type { LoopEvent } from "../../src/loop/loop";
import type { SessionState } from "../../src/session/session";
import { initialTuiState, tuiReducer } from "../../src/tui/reducer";

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

    expect(next.transcript).toEqual(["Session s1: permission mode is now auto"]);
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
      "the streamed answer so far",
      "/mode: permission mode is now auto",
    ]);
    expect(next.streaming).toBe("");
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

    expect(state.transcript).toEqual(["thinking…", `→ read_file({"path":"a.txt"})`]);
    expect(state.streaming).toBe("");
    expect(state.status).toBe("Running read_file…");
  });

  test("a tool-result clears the running status", () => {
    let state = apply(undefined, { type: "tool-call", name: "read_file", args: {} });
    state = apply(state, { type: "tool-result", name: "read_file", result: "ok" });

    expect(state.status).toBe("");
    expect(state.transcript.at(-1)).toBe("✓ read_file done");
  });

  test("permission-denied and tool-allowed each append their own line", () => {
    let state = apply(undefined, {
      type: "permission-denied",
      name: "write_file",
      reason: "declined",
    });
    expect(state.transcript.at(-1)).toBe("✗ write_file blocked");

    state = apply(state, { type: "tool-allowed", name: "write_file" });
    expect(state.transcript.at(-1)).toBe("✓ write_file approved for the rest of this run");
  });

  test("done flushes streamed text, reports the reason, and clears status", () => {
    let state = apply(undefined, { type: "text-delta", text: "the answer" });
    state = apply(state, { type: "done", reason: "no-tool-call" });

    expect(state.transcript).toEqual(["the answer", "(done: no-tool-call)"]);
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
