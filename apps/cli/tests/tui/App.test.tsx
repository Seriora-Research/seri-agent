import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { render } from "ink-testing-library";
import type { SessionState } from "../../src/session/session";
import { App } from "../../src/tui/App";
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

// A render/dispatch is not reflected in lastFrame() synchronously — same finding as the Phase 3
// spike for useInput, just needing a macrotask tick here rather than a microtask (Ink's own frame
// write is throttled independently of React's own update scheduling).
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function connect() {
  let dispatch: ((action: TuiAction) => void) | undefined;
  const instance = render(
    <App session={session()} connectDispatch={(d) => (dispatch = d)} done={false} />,
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
        connectDispatch={(d) => (dispatch = d)}
        done={false}
      />,
    );
    await flush();

    expect(dispatch).toBeDefined();
    expect(instance.lastFrame()).toContain("[read-only]");
  });

  test("a transcript-append dispatch grows the static transcript", async () => {
    const { instance, dispatch } = await connect();

    dispatch({ type: "transcript-append", line: "Session s1: permission mode is now auto" });
    await flush();

    expect(instance.lastFrame()).toContain("Session s1: permission mode is now auto");
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
});
