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

  // MEDIUM-E: a paste — delivered to useInput as one multi-character `input` chunk, not one call
  // per character — can embed a real `\r`/`\n` that `key.return` (which only fires for a chunk
  // that IS a bare terminator on its own) never sees. Before this fix it fell into the plain
  // append branch and the terminator ended up embedded literally in the input, never submitting.
  test("a pasted chunk with an embedded newline submits at the first line, not silently swallowing it", async () => {
    const submitted: string[] = [];
    const instance = render(
      <App session={session()} onSubmit={(v) => submitted.push(v)} done={false} />,
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
      <App session={session()} onSubmit={(v) => submitted.push(v)} done={false} />,
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

  // HIGH-B/MEDIUM-C: Ctrl-D calls the onQuit prop directly — App.tsx wires it through to
  // InputBox unconditionally, so this is the same trigger runTui's own quit() attaches to.
  test("Ctrl-D calls onQuit", async () => {
    let quit = false;
    const instance = render(<App session={session()} onQuit={() => (quit = true)} done={false} />);
    await flush();

    instance.stdin.write("\x04");
    await flush();

    expect(quit).toBe(true);
  });
});
