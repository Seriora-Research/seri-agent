import { describe, expect, test } from "bun:test";
import type { ChildEventPayload } from "../../src/subagents/dispatch";
import { initialTuiState, type TuiState } from "../../src/tui/state/reducer";
import { createStreamDispatch } from "../../src/tui/state/streamDispatch";
import { session } from "./helpers";

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
      event: { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
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
});
