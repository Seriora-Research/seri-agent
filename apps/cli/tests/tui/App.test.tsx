import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import { render } from "ink-testing-library";
import type { ApprovalAnswer } from "../../src/loop/loop";
import type { SessionState } from "../../src/session/session";
import { App, formatContextWindow, formatCost, formatModelRow } from "../../src/tui/App";
import type { ModelPickerEntry, SetupProviderRow } from "../../src/tui/commands";
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
    const instance = render(<App session={session()} onQuit={() => (quit = true)} done={false} />);
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
      return { entry: entry(overrides), keyConfigured: true, alternatives: 0 };
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
          rows: setupRows(),
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
          rows: setupRows(),
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
          rows: setupRows(),
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
          rows: setupRows(),
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
          rows: setupRows(),
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
      return { entry: entry(), keyConfigured: true, alternatives: 0, ...overrides };
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

      const unconfigured = formatModelRow(pickerRow({ keyConfigured: false, alternatives: 0 }));
      expect(unconfigured).toContain("no key");
      expect(unconfigured).not.toContain("your key");

      const withOneAlternative = formatModelRow(pickerRow({ alternatives: 1 }));
      expect(withOneAlternative).toContain("+1 route");
      expect(withOneAlternative).not.toContain("+1 routes");

      const withTwoAlternatives = formatModelRow(pickerRow({ alternatives: 2 }));
      expect(withTwoAlternatives).toContain("+2 routes");
    });

    test("formatModelRow truncates a displayName longer than the name column", () => {
      const row = formatModelRow(pickerRow({ entry: entry({ displayName: "A".repeat(40) }) }));
      expect(row).toContain("…");
      expect(row.indexOf("A".repeat(40))).toBe(-1);
    });
  });
});
