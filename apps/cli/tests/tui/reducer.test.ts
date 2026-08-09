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
});
