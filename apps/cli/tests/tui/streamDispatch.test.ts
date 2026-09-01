import { describe, expect, test } from "bun:test";
import type { ChildEventPayload } from "../../src/subagents/dispatch";
import { initialTuiState, type TuiState } from "../../src/tui/state/reducer";
import { createStreamDispatch } from "../../src/tui/state/streamDispatch";
import { session } from "./helpers";

function usageOf(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens,
    outputTokenDetails: { textTokens: outputTokens, reasoningTokens: undefined },
    totalTokens: inputTokens + outputTokens,
  };
}

function childEvent(
  childId: string,
  role: ChildEventPayload["role"],
  goal: string,
  event: ChildEventPayload["event"],
) {
  return { type: "subagent-child-event" as const, childId, role, goal, event };
}

function harness() {
  let setStateCalls = 0;
  let state: TuiState = initialTuiState(session());
  const stream = createStreamDispatch((updater) => {
    setStateCalls++;
    state = updater(state);
  });
  return {
    dispatch: stream.dispatch,
    get setStateCalls() {
      return setStateCalls;
    },
    get state() {
      return state;
    },
  };
}

describe("createStreamDispatch", () => {
  test("N parent text-deltas do not call setState", () => {
    const h = harness();

    for (let i = 0; i < 20; i++) {
      h.dispatch({ type: "loop-event", event: { type: "text-delta", text: "x" } });
    }

    expect(h.setStateCalls).toBe(0);
  });

  test("a following tool-call flushes the concatenated buffer in one setState", () => {
    const h = harness();

    for (let i = 0; i < 20; i++) {
      h.dispatch({ type: "loop-event", event: { type: "text-delta", text: "x" } });
    }
    h.dispatch({
      type: "loop-event",
      event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
    });

    expect(h.setStateCalls).toBe(1);
    expect(h.state.streaming).toBe("");
    expect(h.state.transcript).toEqual([{ role: "assistant", text: "x".repeat(20) }]);
  });

  test("usage sees pending live estimate before reconciling (pending applied first)", () => {
    const h = harness();

    h.dispatch({ type: "turn-started", startedAt: 1, inputEstimate: 0 });
    h.dispatch({ type: "loop-event", event: { type: "text-delta", text: "hello world" } });
    h.dispatch({
      type: "loop-event",
      event: { type: "usage", usage: usageOf(10, 5) },
    });

    expect(h.state.turn?.tokens.liveOutputEstimate).toBe(0);
    expect(h.state.turn?.tokens.reconciledOutputTokens).toBe(5);
  });

  test("N child text-deltas do not call setState; child tool-call flushes child.streaming", () => {
    const h = harness();

    h.dispatch(childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    const afterStart = h.setStateCalls;
    expect(afterStart).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) {
      h.dispatch(childEvent("t1:0", "explore", "find a", { type: "text-delta", text: "x" }));
    }
    expect(h.setStateCalls).toBe(afterStart);

    h.dispatch(
      childEvent("t1:0", "explore", "find a", {
        type: "tool-call",
        name: "read_file",
        args: { path: "foo.ts" },
      }),
    );

    expect(h.setStateCalls).toBe(afterStart + 1);
    const child = h.state.subagents[0];
    expect(child?.streaming).toBe("");
    expect(child?.transcript).toEqual([{ role: "assistant", text: "x".repeat(20) }]);
  });

  test("a text-delta after queued setState updaters does not drain into those updaters", () => {
    let state: TuiState = initialTuiState(session());
    const queued: Array<(s: TuiState) => TuiState> = [];
    const stream = createStreamDispatch((updater) => {
      queued.push(updater);
    });

    stream.dispatch({ type: "transcript-append", line: "line 0" });
    stream.dispatch({ type: "loop-event", event: { type: "text-delta", text: "secret" } });
    for (const updater of queued) state = updater(state);

    expect(state.transcript).toEqual([{ role: "system", text: "line 0" }]);
    expect(state.streaming).toBe("");

    stream.dispatch({
      type: "loop-event",
      event: { type: "tool-call", name: "read_file", args: {} },
    });
    for (const updater of queued.slice(1)) state = updater(state);

    expect(state.streaming).toBe("");
    expect(state.transcript).toEqual([
      { role: "system", text: "line 0" },
      { role: "assistant", text: "secret" },
    ]);
  });

  test("N reasoning-deltas do not call setState", () => {
    const h = harness();

    for (let i = 0; i < 20; i++) {
      h.dispatch({ type: "loop-event", event: { type: "reasoning-delta", text: "x" } });
    }

    expect(h.setStateCalls).toBe(0);
    expect(h.state.transcript).toEqual([]);
    expect(h.state.reasoning.live).toBeUndefined();
  });

  test("a following tool-call flushes reasoning without an assistant row", () => {
    const h = harness();

    for (let i = 0; i < 20; i++) {
      h.dispatch({ type: "loop-event", event: { type: "reasoning-delta", text: "x" } });
    }
    h.dispatch({
      type: "loop-event",
      event: { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
    });

    expect(h.setStateCalls).toBe(1);
    expect(h.state.streaming).toBe("");
    expect(h.state.transcript.some((entry) => entry.role === "assistant")).toBe(false);
    expect(h.state.transcript.filter((entry) => entry.kind === "reasoning")).toHaveLength(1);
    expect(h.state.transcript[0]?.body).toBe("x".repeat(20));
  });
});
