import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { ModelCatalogEntry } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import type { LoopEvent } from "../../src/loop/loop";
import type { McpPanelRow } from "../../src/mcp/commands";
import type { SessionState } from "../../src/session/session";
import type { ChildEventPayload } from "../../src/subagents/dispatch";
import { rosterModelSuffix } from "../../src/tui/components/SubagentPanel";
import type {
  ConfigRow,
  ModelPickerEntry,
  PermissionRow,
  SetupProviderRow,
} from "../../src/tui/state/commands";
import { initialTuiState, type TuiState, tuiReducer } from "../../src/tui/state/reducer";
import { renderLiveToolActivity, summarizeArgs } from "../../src/tui/state/toolActivity";
import { TOOL_INDENT } from "../../src/tui/theme/spacing";
import { ERROR_MARK, TREE_BRANCH } from "../../src/tui/theme/theme";
import { estimateTokens, formatTokenProgress, type TokenProgress } from "../../src/tui/util/format";

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

const ROADMAP = join("docs", "ROADMAP.md");
const READ_A = `→ Read(a.txt)\n${TOOL_INDENT}Read 1 file`;
const READ_TWO = `→ Read(a.txt)\n${TOOL_INDENT}Read 2 files`;
const RAN_ECHO_A = `→ Bash(echo a)\n${TOOL_INDENT}Ran 1 shell command`;
const RAN_TWO = `→ Bash(echo a)\n${TOOL_INDENT}Ran 2 shell commands`;

describe("initialTuiState", () => {
  test("starts with an empty transcript and the session's own permission mode", () => {
    const state = initialTuiState(session({ permissionMode: "read-only" }));

    expect(state.transcript).toEqual([]);
    expect(state.streaming).toBe("");
    expect(state.reasoning).toEqual({ expanded: false });
    expect(state.session.permissionMode).toBe("read-only");
    expect(state.plan).toEqual({ kind: "off" });
  });
});

describe("tuiReducer: session-updated", () => {
  test("replaces the session", () => {
    const state = initialTuiState(session({ permissionMode: "read-only" }));
    const next = tuiReducer(state, {
      type: "session-updated",
      session: session({ permissionMode: "auto" }),
    });

    expect(next.session.permissionMode).toBe("auto");
  });
});

describe("tuiReducer: user-turn-committed", () => {
  test("merges the messages into the current session, leaving the rest of it alone", () => {
    const state = initialTuiState(session({ permissionMode: "read-only" }));
    const next = tuiReducer(state, {
      type: "user-turn-committed",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(next.session.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(next.session.permissionMode).toBe("read-only");
  });

  // The reason this is not a synthetic `messages-updated`: that event is also the transcript's own
  // signal, and a committed user row must not disturb an answer already streaming into it.
  test("leaves the transcript and the streaming buffer untouched", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "loop-event",
      event: { type: "text-delta", text: "partial" },
    });
    state = tuiReducer(state, {
      type: "user-turn-committed",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(state.transcript).toEqual([]);
    expect(state.streaming).toBe("partial");
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

  test("lands muted and markdown flags on the entry when set, and omits them when unset", () => {
    const state = initialTuiState(session());
    const flagged = tuiReducer(state, {
      type: "transcript-append",
      line: "recorded **bold** fact",
      muted: true,
      markdown: true,
    });
    expect(flagged.transcript).toEqual([
      { role: "system", text: "recorded **bold** fact", muted: true, markdown: true },
    ]);

    const plain = tuiReducer(state, {
      type: "transcript-append",
      line: "Session s1: permission mode is now auto",
    });
    expect(plain.transcript).toEqual([
      { role: "system", text: "Session s1: permission mode is now auto" },
    ]);
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

  // Regression guard: `transcript` stores LOGICAL lines, never pre-wrapped output — a multi-line
  // string committed by one `transcript-append` must stay exactly one array entry, not several.
  test("stores one entry per call, even for a multi-line string", () => {
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

describe("tuiReducer: transcript-cleared", () => {
  // Builds a state where `streaming` is genuinely non-empty before the clear — otherwise the reset
  // assertion would pass vacuously.
  function stateBeforeClear(): TuiState {
    let state: TuiState = initialTuiState(session());
    for (const line of ["a", "b", "c"]) {
      state = tuiReducer(state, { type: "transcript-append", line });
    }
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: "an in-progress answer" },
    });
    return state;
  }

  test("resets transcript and streaming", () => {
    const before = stateBeforeClear();
    expect(before.streaming.length).toBeGreaterThan(0);
    expect(before.transcript.length).toBeGreaterThan(0);

    const next = tuiReducer(before, { type: "transcript-cleared" });

    expect(next.transcript).toEqual([]);
    expect(next.streaming).toBe("");
  });

  test("leaves session untouched", () => {
    const before = stateBeforeClear();
    const next = tuiReducer(before, { type: "transcript-cleared" });

    expect(next.session).toBe(before.session);
  });

  test("turns the plan overlay off and keeps the rest of the session", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "plan-on" });
    state = tuiReducer(state, {
      type: "plan-review-requested",
      plan: { path: "/tmp/p.md", title: "T", markdown: "# T" },
    });
    expect(state.plan.kind).toBe("reviewing");
    const next = tuiReducer(state, { type: "transcript-cleared" });
    expect(next.plan).toEqual({ kind: "off" });
    expect(next.session).toBe(state.session);
  });
});

describe("tuiReducer: parent checklist", () => {
  const items = [
    { id: "a", content: "find compile flags", status: "done" as const },
    { id: "b", content: "add --minify", status: "in_progress" as const },
    { id: "c", content: "add a size test", status: "pending" as const },
  ];
  const first = [{ id: "a", content: "find compile flags", status: "done" as const }];

  function todoCall(list: typeof items | typeof first, toolCallId: string): ModelMessage {
    return {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName: "todo", input: { items: list } }],
    };
  }

  function todoResult(list: typeof items | typeof first, toolCallId: string): ModelMessage {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "todo",
          output: { type: "json", value: list },
        },
      ],
    };
  }

  test("a session with a todo tool-call in messages seeds checklist", () => {
    const state = initialTuiState(
      session({ messages: [todoCall(items, "c1"), todoResult(items, "c1")] }),
    );
    expect(state.checklist).toEqual(items);
  });

  test("session-updated with sliced messages restores the earlier list", () => {
    const messages = [
      todoCall(first, "c1"),
      todoResult(first, "c1"),
      todoCall(items, "c2"),
      todoResult(items, "c2"),
    ];
    const state = initialTuiState(session({ messages }));
    expect(state.checklist).toEqual(items);

    const rewound = tuiReducer(state, {
      type: "session-updated",
      session: session({ messages: messages.slice(0, 2) }),
    });
    expect(rewound.checklist).toEqual(first);
  });

  test("tool-result paints a valid list and tool-call does not", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "tool-call", name: "todo", args: { items } },
    });
    expect(state.checklist).toEqual([]);

    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "tool-result", name: "todo", result: items },
    });
    expect(state.checklist).toEqual(items);
  });

  test("a thrown call does not paint from tool-call args", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "tool-call", name: "todo", args: { items } },
    });
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "error", error: 'Tool "todo" threw during execution: duplicate' },
    });
    expect(state.checklist).toEqual([]);
  });

  test("a denial does not paint", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "tool-call", name: "todo", args: { items } },
    });
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "permission-denied", name: "todo", reason: "declined" },
    });
    expect(state.checklist).toEqual([]);
  });

  test("transcript-cleared empties the checklist", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "tool-result", name: "todo", result: items },
    });
    expect(state.checklist).toEqual(items);
    const next = tuiReducer(state, { type: "transcript-cleared" });
    expect(next.checklist).toEqual([]);
  });
});

describe("tuiReducer: plan overlay", () => {
  test("plan-on / plan-off toggle the overlay", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "plan-on" });
    expect(state.plan).toEqual({ kind: "on" });
    state = tuiReducer(state, { type: "plan-off" });
    expect(state.plan).toEqual({ kind: "off" });
  });

  test("plan-questions-requested parks the clarifying panel", () => {
    const questions = [{ id: "q1", prompt: "Which?", options: ["a", "b"] }];
    const state = tuiReducer(initialTuiState(session()), {
      type: "plan-questions-requested",
      questions,
    });
    expect(state.plan).toEqual({ kind: "clarifying", questions });
  });

  test("plan-review-requested parks the submitted plan", () => {
    const plan = { path: "/tmp/p.md", title: "Auth", markdown: "# Auth\n" };
    const state = tuiReducer(initialTuiState(session()), {
      type: "plan-review-requested",
      plan,
    });
    expect(state.plan).toEqual({ kind: "reviewing", ...plan });
  });
});

describe("tuiReducer: transcript role tagging", () => {
  // The blank row above a user message is a margin (gapBefore, theme/spacing.ts), not an entry, so
  // `state.transcript` holds only what something actually said.
  test('a role: "user" append after existing content lands with no spacer entry before it', () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "transcript-append",
      line: "first",
    });
    state = tuiReducer(state, { type: "transcript-append", line: "> hello", role: "user" });

    expect(state.transcript).toEqual([
      { role: "system", text: "first" },
      { role: "user", text: "> hello" },
    ]);
  });

  // echoUserInput (cli.ts) is the only call site that ever dispatches `role: "user"`, and it always
  // passes `flush: false` (deliberately, so a rejected/echoed submission never fragments an
  // in-progress streamed answer — see pushLine's own comment). Asserted separately from the
  // `flush: true` case above because that combination is the only one a real user turn produces.
  test('role: "user", flush: false (the actual echoUserInput dispatch shape) appends only the echo', () => {
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
      { role: "user", text: "> hello" },
    ]);
  });

  test('the very first entry in a fresh session stands alone, even with role: "user"', () => {
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

  test("tool-call, tool-result, and permission-denied do not push a transcript line", () => {
    const events: LoopEvent[] = [
      { type: "tool-call", name: "read_file", args: { path: "a.txt" } },
      { type: "tool-result", name: "read_file", result: "ok" },
      { type: "permission-denied", name: "write_file", reason: "declined" },
    ];

    let state = initialTuiState(session());
    for (const event of events) {
      const before = state.transcript.length;
      state = tuiReducer(state, { type: "loop-event", event });
      expect(state.transcript.length).toBe(before);
    }
    expect(state.pendingTool).toBeUndefined();
    expect(state.toolActivity.length).toBeGreaterThan(0);
  });

  test('done, error, compacted, retry, and tool-allowed still land as role: "system"', () => {
    const events: LoopEvent[] = [
      { type: "tool-allowed", name: "write_file" },
      {
        type: "compacted",
        summary: { goal: "g", progress: "p", blockers: "b", nextSteps: "n" },
        evictedCount: 3,
        tokensBefore: 100,
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

  test("a tool-call flushes pending streamed text, sets pendingTool for a non-write tool, and does not push raw JSON", () => {
    let state = apply(undefined, { type: "text-delta", text: "thinking…" });
    state = apply(state, { type: "tool-call", name: "read_file", args: { path: "a.txt" } });

    expect(state.transcript).toEqual([{ role: "assistant", text: "thinking…" }]);
    expect(state.streaming).toBe("");
    expect(state.status).toBe("Running read_file…");
    expect(state.pendingTool).toEqual({ name: "read_file", args: { path: "a.txt" } });
    expect(state.transcript.some((e) => e.text.includes("→ Read"))).toBe(false);
  });

  test("a tool-result clears the running status without pushing a transcript line", () => {
    let state = apply(undefined, { type: "tool-call", name: "read_file", args: { path: "a.txt" } });
    state = apply(state, { type: "tool-result", name: "read_file", result: "ok" });

    expect(state.status).toBe("");
    expect(state.pendingTool).toBeUndefined();
    expect(state.transcript).toEqual([]);
    expect(state.toolActivity).toHaveLength(1);
    expect(renderLiveToolActivity(state.toolActivity)).toEqual([READ_A]);
  });

  test("a single successful tool-result followed by done drops the live tree", () => {
    let state = apply(undefined, { type: "tool-call", name: "read_file", args: { path: "a.txt" } });
    state = apply(state, { type: "tool-result", name: "read_file", result: "ok" });
    expect(renderLiveToolActivity(state.toolActivity)).toEqual([READ_A]);
    state = apply(state, { type: "done", reason: "no-tool-call" });

    expect(state.transcript.some((e) => e.text.includes("→ Read"))).toBe(false);
    expect(state.transcript.filter((e) => e.muted && e.text === "Read 1 file")).toHaveLength(1);
    expect(state.transcript.at(-1)).toEqual({ role: "system", text: "done", muted: true });
    expect(state.toolActivity).toEqual([]);
  });

  test("two same-name successful results followed by done drop the aggregated live tree", () => {
    let state = apply(undefined, { type: "tool-call", name: "read_file", args: { path: "a.txt" } });
    state = apply(state, { type: "tool-result", name: "read_file", result: "ok" });
    state = apply(state, { type: "tool-call", name: "read_file", args: { path: "b.txt" } });
    state = apply(state, { type: "tool-result", name: "read_file", result: "ok" });
    expect(renderLiveToolActivity(state.toolActivity)).toEqual([READ_TWO]);
    state = apply(state, { type: "done", reason: "no-tool-call" });

    expect(state.transcript.some((e) => e.text.includes("→ Read"))).toBe(false);
    expect(state.transcript.filter((e) => e.muted && e.text === "Read 2 files")).toHaveLength(1);
    expect(state.toolActivity).toEqual([]);
  });

  test("after two same-name results and before done, live render is one Read 2 files line", () => {
    let state = apply(undefined, { type: "tool-call", name: "read_file", args: { path: "a.txt" } });
    state = apply(state, { type: "tool-result", name: "read_file", result: "ok" });
    expect(renderLiveToolActivity(state.toolActivity)).toEqual([READ_A]);
    expect(state.transcript.filter((e) => e.muted)).toEqual([]);

    state = apply(state, { type: "tool-call", name: "read_file", args: { path: "b.txt" } });
    expect(renderLiveToolActivity(state.toolActivity)).toEqual([READ_A]);

    state = apply(state, { type: "tool-result", name: "read_file", result: "ok" });
    expect(renderLiveToolActivity(state.toolActivity)).toEqual([READ_TWO]);
    expect(state.transcript.filter((e) => e.muted)).toEqual([]);
  });

  test("after two same-name bash results and before done, live render is one Ran 2 shell commands", () => {
    const ok = {
      stdout: "",
      stderr: "",
      exitCode: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    };
    let state = apply(undefined, { type: "tool-call", name: "bash", args: { command: "echo a" } });
    state = apply(state, { type: "tool-result", name: "bash", result: ok });
    expect(renderLiveToolActivity(state.toolActivity)).toEqual([RAN_ECHO_A]);
    state = apply(state, { type: "tool-call", name: "bash", args: { command: "echo b" } });
    state = apply(state, { type: "tool-result", name: "bash", result: ok });
    expect(renderLiveToolActivity(state.toolActivity)).toEqual([RAN_TWO]);
    expect(state.transcript.filter((e) => e.muted)).toEqual([]);
  });

  test("a failing bash result is live-only; done drops the anomaly with the tree", () => {
    let state = apply(undefined, { type: "tool-call", name: "bash", args: { command: "false" } });
    state = apply(state, {
      type: "tool-result",
      name: "bash",
      result: {
        stdout: "",
        stderr: "boom",
        exitCode: 1,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      },
    });
    state = apply(state, { type: "done", reason: "no-tool-call" });

    expect(state.transcript.some((e) => e.text.includes(TREE_BRANCH))).toBe(false);
    expect(state.transcript.some((e) => e.text.includes("exit 1"))).toBe(false);
    expect(state.transcript.some((e) => e.text === "Ran 1 shell command")).toBe(true);
    expect(state.toolActivity).toEqual([]);
  });

  test("a declined permission-denied does not throw; done drops the anomaly with the tree", () => {
    let state = apply(undefined, {
      type: "tool-call",
      name: "write_file",
      args: { path: "a.txt" },
    });
    expect(state.pendingTool).toEqual({ name: "write_file", args: { path: "a.txt" } });
    state = apply(state, { type: "permission-denied", name: "write_file", reason: "declined" });
    state = apply(state, { type: "done", reason: "no-tool-call" });

    expect(state.transcript.some((e) => e.text.includes(TREE_BRANCH))).toBe(false);
    expect(state.transcript.some((e) => e.text.includes("declined"))).toBe(false);
    expect(state.transcript.some((e) => e.text === "Wrote 1 file")).toBe(true);
    expect(state.toolActivity).toEqual([]);
  });

  // HIGH 1: loop.ts yields `error` and continues (compaction catch, unknown tool, thrown
  // execute). Flushing toolActivity on error would split one turn's calls across two muted
  // groups and drop anything that arrives after the error.
  test("a mid-turn error does not flush toolActivity; later tools still aggregate live, then drop on done", () => {
    let state = apply(undefined, {
      type: "tool-call",
      name: "read_file",
      args: { path: "a.txt" },
    });
    state = apply(state, { type: "tool-result", name: "read_file", result: { content: "x" } });
    state = apply(state, { type: "error", error: "compaction failed" });

    expect(state.toolActivity).toHaveLength(1);
    expect(state.transcript.filter((e) => e.muted)).toEqual([]);
    expect(state.transcript.at(-1)?.text).toBe(`${ERROR_MARK}compaction failed`);
    expect(state.transcript.at(-1)?.kind).toBeUndefined();

    state = apply(state, {
      type: "tool-call",
      name: "read_file",
      args: { path: "b.txt" },
    });
    state = apply(state, { type: "tool-result", name: "read_file", result: { content: "y" } });
    state = apply(state, { type: "done", reason: "no-tool-call" });

    expect(state.transcript.some((e) => e.text.includes("→ Read"))).toBe(false);
    expect(state.transcript.some((e) => e.text === "Read 2 files")).toBe(true);
    expect(state.toolActivity).toEqual([]);
  });

  test("a hosted quota hard-stop stays unmarked and tagged, not an ERROR_MARK line", () => {
    const notice =
      "Included spend this month is used up. Hosted routes will not run until 1 Oct 2026 UTC.";
    const state = apply(undefined, { type: "error", error: notice });
    expect(state.transcript.at(-1)?.text).toBe(notice);
    expect(state.transcript.at(-1)?.kind).toBe("quota-exhausted");
    expect(state.transcript.at(-1)?.text.startsWith(ERROR_MARK)).toBe(false);
  });

  // HIGH 2: thrown execute is tool-call then error, no tool-result. Without recordCall the
  // live line vanishes and no settled line is ever committed. The error itself must not
  // become a transcript peer of the assistant's prose — it settles the open group.
  test("a tool-call followed by error (no tool-result) still paints live, then drops the tree on done", () => {
    let state = apply(undefined, {
      type: "tool-call",
      name: "bash",
      args: { command: "explode" },
    });
    state = apply(state, {
      type: "error",
      error: 'Tool "bash" threw during execution: Error: boom',
    });

    expect(state.toolActivity).toHaveLength(1);
    expect(state.pendingTool).toBeUndefined();
    expect(state.transcript).toEqual([]);
    expect(renderLiveToolActivity(state.toolActivity)[0]).toContain(
      `${TOOL_INDENT}${TREE_BRANCH}boom`,
    );

    state = apply(state, { type: "done", reason: "no-tool-call" });

    expect(state.transcript.some((e) => e.text.includes("explode"))).toBe(false);
    expect(state.transcript.some((e) => e.text.includes(`${TREE_BRANCH}boom`))).toBe(false);
    expect(state.transcript.every((e) => !e.text.includes("threw during execution"))).toBe(true);
    expect(state.transcript.some((e) => e.text === "Ran 1 shell command")).toBe(true);
    expect(state.toolActivity).toEqual([]);
  });

  test("a thrown read_file is a file-not-found anomaly, not a raw error line", () => {
    let state = apply(undefined, {
      type: "tool-call",
      name: "read_file",
      args: { path: ROADMAP },
    });
    state = apply(state, {
      type: "error",
      error: `Tool "read_file" threw during execution: Error: ENOENT: no such file or directory, open 'C:\\\\Users\\\\x\\\\docs\\\\ROADMAP.md'`,
    });

    expect(state.transcript).toEqual([]);
    expect(state.pendingTool).toBeUndefined();
    const live = renderLiveToolActivity(state.toolActivity);
    expect(live).toHaveLength(1);
    expect(live[0]).toContain(`→ Read(${ROADMAP})`);
    expect(live[0]).toContain(`${TOOL_INDENT}${TREE_BRANCH}file not found`);
    expect(live[0]).not.toContain("threw during execution");
    expect(live[0]).not.toContain("ENOENT");
  });

  // loop.ts mid-stream / streamText catch yields error then return — no done. HIGH 1 is still
  // correct (error itself must not flush, because some errors continue), but turn-ended is the
  // actual end of that turn and must commit whatever was already recorded.
  test("error then turn-ended without done drops the live tree", () => {
    let state = apply(undefined, {
      type: "tool-call",
      name: "read_file",
      args: { path: "a.txt" },
    });
    state = apply(state, { type: "tool-result", name: "read_file", result: { content: "x" } });
    state = apply(state, { type: "error", error: "stream failed" });

    expect(state.toolActivity).toHaveLength(1);
    expect(state.transcript.filter((e) => e.muted)).toEqual([]);

    state = tuiReducer(state, { type: "turn-ended" });

    expect(state.transcript.some((e) => e.text.includes("→ Read"))).toBe(false);
    expect(state.transcript.some((e) => e.text === "Read 1 file")).toBe(true);
    expect(state.toolActivity).toEqual([]);
  });

  test("tool-allowed still appends immediately, non-muted", () => {
    const state = apply(undefined, { type: "tool-allowed", name: "write_file" });
    expect(state.transcript.at(-1)).toEqual({
      role: "system",
      text: "✓ write_file approved for the rest of this run",
    });
  });

  test("compacted still appends immediately, non-muted", () => {
    const state = apply(undefined, {
      type: "compacted",
      summary: { goal: "g", progress: "p", blockers: "b", nextSteps: "n" },
      evictedCount: 3,
      tokensBefore: 100,
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
    });
    expect(state.transcript.at(-1)).toEqual({
      role: "system",
      text: "⚙ compacted 3 messages",
    });
  });

  test("retry still appends immediately, non-muted", () => {
    const state = apply(undefined, { type: "retry", attempt: 1 });
    expect(state.transcript.at(-1)).toEqual({
      role: "system",
      text: "↻ rate-limited or unavailable; retrying (attempt 1)",
    });
  });

  test("done flushes streamed text and clears status", () => {
    let state = apply(undefined, { type: "text-delta", text: "the answer" });
    state = apply(state, { type: "done", reason: "no-tool-call" });

    expect(state.transcript).toEqual([
      { role: "assistant", text: "the answer" },
      { role: "system", text: "done", muted: true },
    ]);
    expect(state.streaming).toBe("");
    expect(state.status).toBe("");
  });

  test("done without turn-started does not invent token totals", () => {
    const aborted = apply(undefined, { type: "done", reason: "aborted" });
    expect(aborted.transcript.at(-1)).toEqual({
      role: "system",
      text: "done: aborted",
      muted: true,
    });
  });

  test("done with exact usage keeps token totals and hides no-tool-call", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = apply(state, { type: "usage", usage: usageOf(123, 45) });
    const tokens = state.turn?.tokens;
    expect(tokens).toBeDefined();
    state = apply(state, { type: "done", reason: "no-tool-call" });

    const line = state.transcript.at(-1)?.text ?? "";
    expect(line).toBe(`done · ${formatTokenProgress(tokens!)}`);
    expect(line).not.toContain("no-tool-call");
    expect(state.transcript.at(-1)?.muted).toBe(true);
  });

  test("aborted with exact usage keeps the reason and the same token fragment", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = apply(state, { type: "usage", usage: usageOf(123, 45) });
    const fragment = formatTokenProgress(state.turn!.tokens);
    state = apply(state, { type: "done", reason: "aborted" });

    const line = state.transcript.at(-1)?.text ?? "";
    expect(line).toBe(`done: aborted · ${fragment}`);
    expect(line).toContain(fragment);
    expect(state.transcript.at(-1)?.muted).toBe(true);
  });

  test("max-iterations and repeated-denials keep the reason plus totals", () => {
    for (const reason of ["max-iterations", "repeated-denials"] as const) {
      let state = tuiReducer(initialTuiState(session()), {
        type: "turn-started",
        startedAt: 1,
        inputEstimate: 0,
      });
      state = apply(state, { type: "usage", usage: usageOf(123, 45) });
      const fragment = formatTokenProgress(state.turn!.tokens);
      state = apply(state, { type: "done", reason });

      const line = state.transcript.at(-1)?.text ?? "";
      expect(line).toBe(`done: ${reason} · ${fragment}`);
    }
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
    subscriptionCovered: false,
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

  test("model-picker-resolved uses a caller-supplied route even when keyConfigured is false", () => {
    let state = tuiReducer(
      initialTuiState(session(), {
        route: {
          model: "openai/gpt-oss-120b",
          provider: "openrouter",
          rerouted: false,
          credential: "gateway",
        },
      }),
      { type: "model-picker-requested", entries: [row] },
    );

    state = tuiReducer(state, {
      type: "model-picker-resolved",
      pick: { model: "minimax/minimax-m3:free", provider: "openrouter", keyConfigured: false },
      route: {
        model: "minimax/minimax-m3:free",
        provider: "openrouter",
        rerouted: false,
        credential: "gateway",
      },
    });

    expect(state.route).toEqual({
      model: "minimax/minimax-m3:free",
      provider: "openrouter",
      rerouted: false,
      credential: "gateway",
    });
  });

  test("model-picker-resolved without a supplied route leaves state.route alone when keyConfigured is false", () => {
    const previous = {
      model: "openai/gpt-oss-120b",
      provider: "openrouter" as const,
      rerouted: false,
      credential: "gateway" as const,
    };
    let state = tuiReducer(initialTuiState(session(), { route: previous }), {
      type: "model-picker-requested",
      entries: [row],
    });

    state = tuiReducer(state, {
      type: "model-picker-resolved",
      pick: { model: "minimax/minimax-m3:free", provider: "openrouter", keyConfigured: false },
    });

    expect(state.route).toEqual(previous);
  });
});

describe("tuiReducer: setup-requested / setup-step / setup-resolved", () => {
  const rows: SetupProviderRow[] = [
    {
      kind: "key",
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

  test("setup-requested skips heading rows when choosing the initial selection", () => {
    const mixed: SetupProviderRow[] = [
      { kind: "heading", label: "API keys" },
      {
        kind: "key",
        provider: "groq",
        keyName: "GROQ_API_KEY",
        source: "unset",
        masked: undefined,
        removable: false,
      },
    ];
    const state = tuiReducer(initialTuiState(session()), { type: "setup-requested", rows: mixed });
    expect(state.pendingSetup).toEqual({ step: "list", rows: mixed, selected: 1 });
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

// EffortPanel's own live picker, mirroring model-picker-requested/
// model-picker-resolved's own shape above rather than permissions' three-action one — there is
// only one step here.
describe("tuiReducer: effort-requested / effort-resolved", () => {
  test("effort-requested opens pendingEffort with the given tiers and selected index", () => {
    const state = tuiReducer(initialTuiState(session()), {
      type: "effort-requested",
      tiers: ["low", "medium", "high"],
      selected: 1,
    });

    expect(state).toEqual({
      ...initialTuiState(session()),
      pendingEffort: { tiers: ["low", "medium", "high"], selected: 1 },
    });
  });

  test("effort-resolved with a tier merges it into session.reasoningEffort and clears the picker in the same dispatch", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "effort-requested",
      tiers: ["low", "medium", "high"],
      selected: 0,
    });

    state = tuiReducer(state, { type: "effort-resolved", tier: "high" });

    expect(state).toEqual({
      ...initialTuiState(session()),
      session: { ...session(), reasoningEffort: "high" },
    });
  });

  // Mirrors model-picker-resolved's own "merges into the CURRENT session, not a stale one"
  // regression guard — the identical race (a messages-updated landing between open and resolve)
  // applies here too.
  test("effort-resolved merges into the CURRENT session, not a stale one captured when the picker opened", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "effort-requested",
      tiers: ["low", "medium", "high"],
      selected: 0,
    });
    state = tuiReducer(state, {
      type: "session-updated",
      session: session({ id: "s2", messages: [{ role: "user", content: "hi" }] }),
    });

    state = tuiReducer(state, { type: "effort-resolved", tier: "high" });

    expect(state.session).toEqual({
      ...session({ id: "s2", messages: [{ role: "user", content: "hi" }] }),
      reasoningEffort: "high",
    });
  });

  test("effort-resolved with no tier (cancelled) only clears the picker, leaving session untouched", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "effort-requested",
      tiers: ["low", "medium", "high"],
      selected: 0,
    });

    state = tuiReducer(state, { type: "effort-resolved" });

    expect(state).toEqual(initialTuiState(session()));
  });

  test("effort-resolved with leftoverInput sets pendingInputPrefill", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "effort-requested",
      tiers: ["low", "medium", "high"],
      selected: 0,
    });

    state = tuiReducer(state, {
      type: "effort-resolved",
      tier: "medium",
      leftoverInput: "typed after close",
    });

    expect(state).toEqual({
      ...initialTuiState(session()),
      session: { ...session(), reasoningEffort: "medium" },
      pendingInputPrefill: "typed after close",
    });
  });
});

describe("tuiReducer: chrome-requested / chrome-loaded / chrome-closed", () => {
  test("chrome-requested opens pendingChrome in the loading state and bumps generation", () => {
    const first = tuiReducer(initialTuiState(session()), {
      type: "chrome-requested",
      tab: "usage",
      detail: false,
    });
    expect(first.pendingChrome).toEqual({
      tab: "usage",
      detail: false,
      load: { status: "loading" },
      generation: 1,
    });

    const second = tuiReducer(first, { type: "chrome-requested", tab: "usage", detail: true });
    expect(second.pendingChrome?.generation).toBe(2);
    expect(second.pendingChrome?.detail).toBe(true);
    expect(second.pendingChrome?.load).toEqual({ status: "loading" });
  });

  test("chrome-loaded applies only when generation matches", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "chrome-requested",
      tab: "usage",
      detail: false,
    });
    const generation = state.pendingChrome!.generation;

    state = tuiReducer(state, {
      type: "chrome-loaded",
      generation: generation + 1,
      load: { status: "logged-out" },
    });
    expect(state.pendingChrome?.load).toEqual({ status: "loading" });

    state = tuiReducer(state, {
      type: "chrome-loaded",
      generation,
      load: { status: "logged-out" },
    });
    expect(state.pendingChrome?.load).toEqual({ status: "logged-out" });
  });

  test("chrome-closed clears the panel and carries leftoverInput into pendingInputPrefill", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "chrome-requested",
      tab: "usage",
      detail: false,
    });
    state = tuiReducer(state, {
      type: "chrome-closed",
      leftoverInput: "still typing",
    });
    expect(state.pendingChrome).toBeUndefined();
    expect(state.pendingInputPrefill).toBe("still typing");
  });
});

describe("tuiReducer: mcp-requested / mcp-closed", () => {
  const rows: McpPanelRow[] = [
    { kind: "header", scope: "project", sourceFile: ".seri/mcp/servers.yaml" },
    {
      kind: "server",
      name: "exa",
      scope: "project",
      status: { state: "connected", toolCount: 4 },
      toolCount: 4,
    },
  ];

  test("mcp-requested opens pendingMcp with the given rows, mirroring skills-requested", () => {
    const state = tuiReducer(initialTuiState(session()), { type: "mcp-requested", rows });

    expect(state).toEqual({ ...initialTuiState(session()), pendingMcp: { rows } });
  });

  test("mcp-closed clears pendingMcp", () => {
    let state = tuiReducer(initialTuiState(session()), { type: "mcp-requested", rows });
    state = tuiReducer(state, { type: "mcp-closed" });

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

  test("initialTuiState with authOffer: true sets authOffer", () => {
    expect(initialTuiState(session(), { authOffer: true }).authOffer).toBe(true);
  });

  test("splash-requested sets pendingSplash to true from a default-false state", () => {
    const state = tuiReducer(initialTuiState(session()), { type: "splash-requested" });

    expect(state).toEqual({ ...initialTuiState(session()), pendingSplash: true });
  });

  test("splash-resolved clears pendingSplash, latches splashDone, and touches nothing else", () => {
    const state = tuiReducer(initialTuiState(session(), { showSplash: true }), {
      type: "splash-resolved",
    });

    // `splashDone` is the one field that differs from a fresh state: it is what tells "after the
    // splash" from "before it", which `pendingSplash: false` alone cannot (app.tsx's own
    // pre-session input branch).
    expect(state).toEqual({ ...initialTuiState(session()), splashDone: true });
  });
});

// A LanguageModelUsage fixture with the two fields this reducer actually reads (inputTokens/
// outputTokens) and every other field the type requires — factored out once the multi-call test
// below needs it twice.
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

describe("tuiReducer: turn-started", () => {
  test("sets turn.startedAt to the given value and seeds tokens.liveInputEstimate from inputEstimate", () => {
    const state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 12345,
      inputEstimate: 7,
    });

    expect(state.turn?.startedAt).toBe(12345);
    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 0,
      reconciledOutputTokens: 0,
      liveInputEstimate: 7,
      carriedOutputEstimate: 0,
      liveOutputEstimate: 0,
      exact: false,
      hasGap: false,
    });
  });

  // A second turn must not inherit the first turn's token count, even for one frame — turn-started
  // always resets `turn.tokens` from scratch rather than only seeding it when undefined. Also
  // covers `hasGap`: the previous turn's sticky gap (from a partial usage event) must not survive
  // into the fresh turn either — only "turn-started" ever resets it. The second turn's own
  // `inputEstimate` (3, distinct from the first turn's 5) is what proves the reset is a genuine
  // re-seed from the new turn's own text, not a stale carry-over.
  test("a second turn-started resets turn.tokens (including a sticky hasGap) to its own fresh inputEstimate", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 5,
    });
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: "some streamed text" },
    });
    expect(state.turn?.tokens.liveOutputEstimate).toBeGreaterThan(0);
    state = tuiReducer(state, {
      type: "loop-event",
      event: {
        type: "usage",
        usage: { ...usageOf(0, 0), inputTokens: 10, outputTokens: undefined },
      },
    });
    expect(state.turn?.tokens.hasGap).toBe(true);

    state = tuiReducer(state, { type: "turn-started", startedAt: 2, inputEstimate: 3 });

    expect(state.turn?.startedAt).toBe(2);
    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 0,
      reconciledOutputTokens: 0,
      liveInputEstimate: 3,
      carriedOutputEstimate: 0,
      liveOutputEstimate: 0,
      exact: false,
      hasGap: false,
    });
  });
});

describe("applyLoopEvent: text-delta with turn.tokens", () => {
  function apply(state: TuiState, event: LoopEvent) {
    return tuiReducer(state, { type: "loop-event", event });
  }

  test("accumulates liveOutputEstimate via estimateTokens, leaving reconciled totals/exact untouched", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = apply(state, { type: "text-delta", text: "hello world" });

    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 0,
      reconciledOutputTokens: 0,
      liveInputEstimate: 0,
      carriedOutputEstimate: 0,
      liveOutputEstimate: estimateTokens("hello world"),
      exact: false,
      hasGap: false,
    });
  });

  test("accumulates across multiple text-delta events, chunked any way, to the same total", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = apply(state, { type: "text-delta", text: "hello " });
    state = apply(state, { type: "text-delta", text: "world" });

    expect(state.turn?.tokens.liveOutputEstimate).toBe(estimateTokens("hello world"));
  });

  test("is a no-op on turn when no turn is in flight (turn undefined)", () => {
    const state = apply(initialTuiState(session()), { type: "text-delta", text: "hello" });

    expect(state.turn).toBeUndefined();
  });
});

describe("applyLoopEvent: usage reconciles turn.tokens", () => {
  function apply(state: TuiState, event: LoopEvent) {
    return tuiReducer(state, { type: "loop-event", event });
  }

  test("adds the exact counts onto the reconciled totals, resets liveOutputEstimate, and flips exact", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = apply(state, { type: "text-delta", text: "a whole lot of streamed text here" });

    state = apply(state, { type: "usage", usage: usageOf(100, 42) });

    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 100,
      reconciledOutputTokens: 42,
      liveInputEstimate: 0,
      carriedOutputEstimate: 0,
      liveOutputEstimate: 0,
      exact: true,
      hasGap: false,
    });
  });

  test("is a no-op when no turn is in flight (turn undefined)", () => {
    const state = apply(initialTuiState(session()), { type: "usage", usage: usageOf(5, 5) });

    expect(state.turn).toBeUndefined();
  });

  // liveInputEstimate mirrors liveOutputEstimate's own reset rule (its own comment, reducer.ts):
  // zeroed only when THIS reconciliation's inputTokens is real, kept otherwise.
  test("resets liveInputEstimate to 0 once a real usage.inputTokens reconciles", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 12,
    });
    expect(state.turn?.tokens.liveInputEstimate).toBe(12);

    state = apply(state, { type: "usage", usage: usageOf(100, 42) });

    expect(state.turn?.tokens.liveInputEstimate).toBe(0);
    expect(state.turn?.tokens.reconciledInputTokens).toBe(100);
  });

  test("leaves liveInputEstimate untouched when usage.inputTokens is undefined", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 12,
    });

    state = apply(state, {
      type: "usage",
      usage: { ...usageOf(0, 42), inputTokens: undefined },
    });

    expect(state.turn?.tokens.liveInputEstimate).toBe(12);
    expect(state.turn?.tokens.hasGap).toBe(true);
  });

  // loop.ts's own comment on its failed-mid-stream `usage` yield: a stream that fails partway
  // through resolves `result.usage` with both `inputTokens`/`outputTokens` undefined — that call was
  // never actually measured. Nothing about it can ever be recovered, so this must set the sticky
  // `hasGap` (a bug fixed here: an earlier version of reconcileUsage returned early as a total no-op
  // for this exact case, leaving `hasGap` unset even though a call's real numbers were now
  // permanently unmeasurable) and move whatever live estimate had accumulated onto
  // `carriedOutputEstimate` rather than leaving it in `liveOutputEstimate`, where the NEXT call's own
  // streaming would blend into it indistinguishably.
  test("a usage event with both token fields undefined carries the live estimate forward and sets hasGap", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = apply(state, { type: "text-delta", text: "streamed before the failure" });
    const liveEstimate = estimateTokens("streamed before the failure");

    state = apply(state, {
      type: "usage",
      usage: { ...usageOf(0, 0), inputTokens: undefined, outputTokens: undefined },
    });

    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 0,
      reconciledOutputTokens: 0,
      liveInputEstimate: 0,
      carriedOutputEstimate: liveEstimate,
      liveOutputEstimate: 0,
      exact: false,
      hasGap: true,
    });
  });

  // Bug B regression: a call that fails with no usable usage data at all must not go unmarked just
  // because a LATER call in the same turn reconciles completely — the failed call's real numbers are
  // permanently unmeasurable, and `hasGap` (sticky) plus `formatTokenProgress`'s `~` marker are what
  // keep the turn's aggregate from claiming a false exactness after that.
  test("a both-undefined usage event followed by a later complete one still shows the ~ marker", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = apply(state, { type: "text-delta", text: "streamed before the failure" });

    state = apply(state, {
      type: "usage",
      usage: { ...usageOf(0, 0), inputTokens: undefined, outputTokens: undefined },
    });
    expect(state.turn?.tokens.hasGap).toBe(true);

    state = apply(state, { type: "usage", usage: usageOf(5, 7) });

    expect(state.turn?.tokens.exact).toBe(true);
    expect(state.turn?.tokens.hasGap).toBe(true);
    expect(formatTokenProgress(state.turn?.tokens as TokenProgress)).toMatch(/^~/);
  });

  // reconcileUsage folds in whichever field IS defined rather than discarding it, and sets the
  // sticky `hasGap` since that call's missing field can never be recovered — see reconcileUsage's
  // own comment (reducer.ts). A second, later call reconciling completely must still ADD its real
  // numbers onto the total (not replace it) and must NOT clear `hasGap`.
  test("a usage event with only one token field undefined still folds in the defined field and sets hasGap", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = apply(state, { type: "text-delta", text: "streamed before the partial usage" });
    const liveEstimate = estimateTokens("streamed before the partial usage");

    // Call 1: partial usage (10 real input tokens, output never measured).
    state = apply(state, {
      type: "usage",
      usage: { ...usageOf(0, 0), inputTokens: 10, outputTokens: undefined },
    });

    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 10,
      reconciledOutputTokens: 0,
      liveInputEstimate: 0,
      carriedOutputEstimate: liveEstimate,
      liveOutputEstimate: 0,
      exact: false,
      hasGap: true,
    });

    // Call 2: a later, fully-known usage event. Its real numbers must be SUMMED onto call 1's
    // partial total (15 in, not 5 in) — and call 1's own stranded output estimate must survive
    // (Bug A: an earlier version zeroed it here, discarding the only information ever obtained about
    // call 1's output) — and the turn must never claim full exactness again, since call 1's output
    // was permanently lost.
    state = apply(state, { type: "usage", usage: usageOf(5, 7) });

    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 15,
      reconciledOutputTokens: 7,
      liveInputEstimate: 0,
      carriedOutputEstimate: liveEstimate,
      liveOutputEstimate: 0,
      exact: true,
      hasGap: true,
    });
    expect(formatTokenProgress(state.turn?.tokens as TokenProgress)).toBe(
      `~15 ↑, ~${Math.round(7 + liveEstimate)} ↓`,
    );
  });

  // Bug A regression: call 1's own stranded output estimate must not be silently absorbed into
  // call 2's own growing live estimate (both live in `liveOutputEstimate` while call 2 streams) and
  // then discarded the moment call 2's usage reconciles with a real `outputTokens` (an earlier
  // version zeroed `liveOutputEstimate` unconditionally whenever the new call's own `outputTokens`
  // was real, wiping out whatever call 1 had left behind). `carriedOutputEstimate` is what keeps the
  // two calls' estimates separate.
  test("a stranded estimate from an earlier partial call survives a later call's own streaming and reconciliation", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });

    // Call 1 streams, then reconciles with only inputTokens real.
    state = apply(state, { type: "text-delta", text: "call one's streamed text" });
    const call1Estimate = estimateTokens("call one's streamed text");
    state = apply(state, {
      type: "usage",
      usage: { ...usageOf(0, 0), inputTokens: 20, outputTokens: undefined },
    });
    expect(state.turn?.tokens.carriedOutputEstimate).toBe(call1Estimate);
    expect(state.turn?.tokens.liveOutputEstimate).toBe(0);

    // Call 2 starts streaming its OWN new text — this must accumulate on top of the now-zeroed
    // liveOutputEstimate, not on top of call 1's carried-over estimate.
    state = apply(state, { type: "text-delta", text: "call two's own streamed text" });
    const call2Estimate = estimateTokens("call two's own streamed text");
    expect(state.turn?.tokens.liveOutputEstimate).toBe(call2Estimate);
    expect(state.turn?.tokens.carriedOutputEstimate).toBe(call1Estimate);

    // Call 2 reconciles completely — call 1's carried estimate must still be present in the total.
    state = apply(state, { type: "usage", usage: usageOf(9, 30) });

    expect(state.turn?.tokens.carriedOutputEstimate).toBe(call1Estimate);
    expect(state.turn?.tokens.reconciledOutputTokens).toBe(30);
    const displayedOutTotal = Math.round(30 + call1Estimate);
    expect(formatTokenProgress(state.turn?.tokens as TokenProgress)).toBe(
      `~29 ↑, ~${displayedOutTotal} ↓`,
    );
  });

  // reconcileUsage's own comment (reducer.ts) explains why this adds onto the running totals
  // rather than replacing them; this is that behavior exercised across a real 2-call turn.
  test("a 2-model-call turn accumulates usage across calls without double-counting or losing the first call's total", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });

    // Call 1 streams, then reconciles.
    state = apply(state, { type: "text-delta", text: "call one's streamed text" });
    state = apply(state, { type: "usage", usage: usageOf(100, 42) });
    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 100,
      reconciledOutputTokens: 42,
      liveInputEstimate: 0,
      carriedOutputEstimate: 0,
      liveOutputEstimate: 0,
      exact: true,
      hasGap: false,
    });

    // Call 2 (the tool loop continuing) starts streaming its own new text — this must NOT include
    // call 1's already-reconciled amount a second time, and must revert the display to estimated.
    state = apply(state, { type: "text-delta", text: "call two's own streamed text" });
    expect(state.turn?.tokens.liveOutputEstimate).toBe(
      estimateTokens("call two's own streamed text"),
    );
    expect(state.turn?.tokens.reconciledOutputTokens).toBe(42);
    expect(state.turn?.tokens.exact).toBe(false);

    // Call 2 reconciles: ADDS onto call 1's total rather than replacing it.
    state = apply(state, { type: "usage", usage: usageOf(80, 30) });
    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 180,
      reconciledOutputTokens: 72,
      liveInputEstimate: 0,
      carriedOutputEstimate: 0,
      liveOutputEstimate: 0,
      exact: true,
      hasGap: false,
    });
  });
});

describe("applyLoopEvent: compacted folds its own usage into turn.tokens", () => {
  function apply(state: TuiState, event: LoopEvent) {
    return tuiReducer(state, { type: "loop-event", event });
  }

  const compactedEvent: LoopEvent = {
    type: "compacted",
    summary: { goal: "g", progress: "p", blockers: "b", nextSteps: "n" },
    evictedCount: 3,
    tokensBefore: 100,
    usage: usageOf(60, 15),
  };

  test("adds the summarizer's own usage onto the reconciled totals and marks it exact", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = apply(state, { type: "text-delta", text: "streamed before compaction" });

    state = apply(state, compactedEvent);

    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 60,
      reconciledOutputTokens: 15,
      liveInputEstimate: 0,
      carriedOutputEstimate: 0,
      liveOutputEstimate: 0,
      exact: true,
      hasGap: false,
    });
  });

  test("is a no-op on turn when no turn is in flight (turn undefined)", () => {
    const state = apply(initialTuiState(session()), compactedEvent);

    expect(state.turn).toBeUndefined();
  });
});

// The reducer's own "done" case no longer clears turn state directly — turn-ended (dispatched by
// cli.ts once driveLoop's own call has genuinely settled) is the sole owner of that clearing, so a
// bare "done" LoopEvent must leave `state.turn` as it was.
describe("tuiReducer: done does not clear turn state — only turn-ended does", () => {
  function apply(state: TuiState, event: LoopEvent) {
    return tuiReducer(state, { type: "loop-event", event });
  }

  test("done leaves state.turn defined", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    const turn = state.turn;
    state = apply(state, { type: "done", reason: "no-tool-call" });

    expect(state.turn).toBe(turn);
  });
});

// "turn-ended"'s own comment (TuiAction, reducer.ts) explains why a bare "error" LoopEvent must
// not end a turn.
describe("tuiReducer: error does not end a turn — only turn-ended does", () => {
  function apply(state: TuiState, event: LoopEvent) {
    return tuiReducer(state, { type: "loop-event", event });
  }

  test("an error mid-turn leaves state.turn defined and still accumulating", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = apply(state, { type: "text-delta", text: "before the hiccup" });
    const startedAt = state.turn?.startedAt;

    state = apply(state, {
      type: "error",
      error: 'Unknown tool "frobnicate": no matching tool definition.',
    });

    expect(state.turn?.startedAt).toBe(startedAt);

    state = apply(state, { type: "text-delta", text: " and after it" });

    expect(state.turn?.startedAt).toBe(startedAt);
    expect(state.turn?.tokens.liveOutputEstimate).toBe(
      estimateTokens("before the hiccup") + estimateTokens(" and after it"),
    );
  });

  test("turn-ended clears state.turn", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = apply(state, { type: "error", error: "boom" });
    expect(state.turn).toBeDefined();

    state = tuiReducer(state, { type: "turn-ended" });

    expect(state.turn).toBeUndefined();
  });
});

type ChildViewProbe = {
  id: string;
  role: string;
  goal: string;
  status: string;
  currentTool?: { name: string; args: unknown };
  streaming: string;
  toolActivity: Array<{ anomalyLines: string[] }>;
  model?: string;
  provider?: string;
  inherited?: boolean;
};

function panel(state: TuiState): {
  subagents: ChildViewProbe[];
  subagentPanelFocus: boolean;
  subagentPanelSelectedId: string | undefined;
  pendingChildView: string | undefined;
} {
  const extra = state as TuiState & {
    subagents?: ChildViewProbe[];
    subagentPanelFocus?: boolean;
    subagentPanelSelectedId?: string;
    pendingChildView?: string;
  };
  return {
    subagents: extra.subagents ?? [],
    subagentPanelFocus: extra.subagentPanelFocus ?? false,
    subagentPanelSelectedId: extra.subagentPanelSelectedId,
    pendingChildView: extra.pendingChildView,
  };
}

function childEvent(
  childId: string,
  role: ChildEventPayload["role"],
  goal: string,
  event: ChildEventPayload["event"],
  extra?: Pick<ChildEventPayload, "model" | "provider" | "inherited">,
) {
  return { type: "subagent-child-event" as const, childId, role, goal, event, ...extra };
}

describe("tuiReducer: subagent-child-event", () => {
  test("child-started then child tool-call sets currentTool without touching the parent transcript", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "tool-call",
        name: "read_file",
        args: { path: "foo.ts" },
      }),
    );

    const child = panel(state).subagents[0];
    expect(child?.id).toBe("t1:0");
    expect(child?.currentTool).toEqual({ name: "read_file", args: { path: "foo.ts" } });
    expect(summarizeArgs(child.currentTool!.name, child.currentTool!.args)).toBe("Read foo.ts");
    expect(state.transcript).toEqual([]);
    expect(state.toolActivity).toEqual([]);
    expect(state.pendingTool).toBeUndefined();
  });

  test("a child tool-result clears currentTool so a later error is not a false throw", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "tool-call",
        name: "read_file",
        args: { path: "foo.ts" },
      }),
    );
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "tool-result",
        name: "read_file",
        result: "ok",
      }),
    );

    const afterResult = panel(state).subagents[0];
    expect(afterResult?.currentTool).toBeUndefined();

    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "error",
        error: "lint could not be run",
      }),
    );
    const child = panel(state).subagents[0];
    expect(child?.currentTool).toBeUndefined();
    expect(child?.status).toBe("error");
    expect(child?.toolActivity[0]?.anomalyLines).toEqual([]);
  });

  test("a child permission-denied clears currentTool", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "tool-call",
        name: "read_file",
        args: { path: "foo.ts" },
      }),
    );
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "permission-denied",
        name: "read_file",
        reason: "hook",
      }),
    );
    expect(panel(state).subagents[0]?.currentTool).toBeUndefined();
  });

  test("a child tool-call then error settles an anomaly and clears currentTool", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "tool-call",
        name: "read_file",
        args: { path: "foo.ts" },
      }),
    );
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "error",
        error: 'Tool "read_file" threw during execution: Error: ENOENT: no such file or directory',
      }),
    );

    const child = panel(state).subagents[0];
    expect(child?.currentTool).toBeUndefined();
    expect(child?.status).toBe("error");
    expect(child?.toolActivity[0]?.anomalyLines).toEqual(["file not found"]);
    expect(state.transcript).toEqual([]);
  });

  test("child-started copies the actual model pair when the child did not inherit", () => {
    let state = initialTuiState(session());
    state = tuiReducer(
      state,
      childEvent(
        "t1:0",
        "oracle",
        "advise",
        { type: "child-started" },
        { model: "claude-sonnet-5", provider: "anthropic", inherited: false },
      ),
    );
    const child = panel(state).subagents[0];
    expect(child?.role).toBe("oracle");
    expect(child?.model).toBe("claude-sonnet-5");
    expect(child?.provider).toBe("anthropic");
    expect(child?.inherited).toBe(false);
  });

  test("rosterModelSuffix shows the model only when the child did not inherit", () => {
    expect(rosterModelSuffix({ inherited: false, model: "claude-sonnet-5" })).toBe(
      "claude-sonnet-5",
    );
    expect(rosterModelSuffix({ inherited: true, model: "solo-model" })).toBeUndefined();
    expect(rosterModelSuffix({ inherited: undefined, model: "solo-model" })).toBeUndefined();
  });

  test("child text-delta accumulates on streaming and does not change currentTool", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "tool-call",
        name: "read_file",
        args: { path: "foo.ts" },
      }),
    );
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", { type: "text-delta", text: "Hel" }),
    );
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", { type: "text-delta", text: "lo" }),
    );

    const child = panel(state).subagents[0];
    expect(child?.currentTool).toEqual({ name: "read_file", args: { path: "foo.ts" } });
    expect(child?.streaming).toBe("Hello");
    expect(state.streaming).toBe("");
  });

  test("six child-started rows stay on the roster", () => {
    let state = initialTuiState(session());
    for (let i = 0; i < 6; i++) {
      state = tuiReducer(
        state,
        childEvent(`t1:${i}`, "explore", `find ${i}`, { type: "child-started" }),
      );
    }

    expect(panel(state).subagents).toHaveLength(6);
    expect(panel(state).subagents.map((c) => c.id)).toEqual([
      "t1:0",
      "t1:1",
      "t1:2",
      "t1:3",
      "t1:4",
      "t1:5",
    ]);
  });

  test("a child done event does not clear the roster", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", { type: "done", reason: "no-tool-call" }),
    );

    expect(panel(state).subagents).toHaveLength(1);
    expect(panel(state).subagents[0]?.id).toBe("t1:0");
    expect(panel(state).subagents[0]?.status).toBe("done");
  });

  test("a non-dispatch tool-result does not clear the roster", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "tool-result", name: "read_file", result: "ok" },
    });

    expect(panel(state).subagents).toHaveLength(1);
    expect(panel(state).subagents[0]?.id).toBe("t1:0");
  });

  test("parent dispatch_subagents tool-result with no overlay clears subagents", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    expect(panel(state).subagents).toHaveLength(1);
    state = tuiReducer(state, {
      type: "loop-event",
      event: {
        type: "tool-result",
        name: "dispatch_subagents",
        result: { results: [{ doneReason: "no-tool-call" }], totalUsage: {} },
      },
    });

    expect(panel(state).subagents).toEqual([]);
    expect(panel(state).subagentPanelFocus).toBe(false);
    expect(panel(state).subagentPanelSelectedId).toBeUndefined();
    expect(panel(state).pendingChildView).toBeUndefined();
  });

  test("parent dispatch_subagents tool-result with a child view clears the roster and the view", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(state, childEvent("t1:1", "explore", "find b", { type: "child-started" }));
    state = tuiReducer(state, { type: "subagent-overlay-open", id: "t1:0" });
    state = tuiReducer(state, { type: "subagent-panel-focus" });
    state = tuiReducer(state, {
      type: "loop-event",
      event: {
        type: "tool-result",
        name: "dispatch_subagents",
        result: {
          results: [{ doneReason: "no-tool-call" }, { doneReason: "no-tool-call" }],
          totalUsage: {},
        },
      },
    });

    expect(panel(state).subagents).toEqual([]);
    expect(panel(state).pendingChildView).toBeUndefined();
    expect(panel(state).subagentPanelFocus).toBe(false);
    expect(panel(state).subagentPanelSelectedId).toBeUndefined();
  });

  test("turn-started clears the roster and the child view", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(state, { type: "subagent-overlay-open", id: "t1:0" });
    state = tuiReducer(state, { type: "subagent-panel-focus" });
    state = tuiReducer(state, { type: "turn-started", startedAt: 1, inputEstimate: 0 });

    expect(panel(state).subagents).toEqual([]);
    expect(panel(state).pendingChildView).toBeUndefined();
    expect(panel(state).subagentPanelFocus).toBe(false);
    expect(panel(state).subagentPanelSelectedId).toBeUndefined();
  });

  test("transcript-cleared clears the roster and the child view", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(state, { type: "subagent-overlay-open", id: "t1:0" });
    state = tuiReducer(state, { type: "subagent-panel-focus" });
    state = tuiReducer(state, { type: "transcript-cleared" });

    expect(panel(state).subagents).toEqual([]);
    expect(panel(state).pendingChildView).toBeUndefined();
    expect(panel(state).subagentPanelFocus).toBe(false);
    expect(panel(state).subagentPanelSelectedId).toBeUndefined();
  });

  test("subagent-panel-focus with no selected id defaults to main", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(state, { type: "subagent-panel-focus" });

    expect(panel(state).subagentPanelFocus).toBe(true);
    expect(panel(state).subagentPanelSelectedId).toBe("main");
  });

  test("overlay-close after selecting main restores the parent view and keeps children", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(state, childEvent("t1:1", "explore", "find b", { type: "child-started" }));
    state = tuiReducer(state, { type: "subagent-overlay-open", id: "t1:0" });
    state = tuiReducer(state, { type: "subagent-panel-select", id: "main" });
    state = tuiReducer(state, { type: "subagent-overlay-close" });

    expect(panel(state).pendingChildView).toBeUndefined();
    expect(panel(state).subagents.map((c) => c.id)).toEqual(["t1:0", "t1:1"]);
    expect(panel(state).subagentPanelSelectedId).toBe("main");
  });

  test("two explore children store the raw role, not a numbered label", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(state, childEvent("t1:1", "explore", "find b", { type: "child-started" }));

    expect(panel(state).subagents.map((c) => c.role)).toEqual(["explore", "explore"]);
  });

  test("child permission-denied records a row anomaly and does not set pendingApproval", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "tool-call",
        name: "write_file",
        args: { path: "a.txt", content: "x" },
      }),
    );
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "permission-denied",
        name: "write_file",
        reason: "blocked",
      }),
    );

    const child = panel(state).subagents[0];
    expect(child?.toolActivity.some((e) => e.anomalyLines.includes("blocked"))).toBe(true);
    expect(state.pendingApproval).toBeUndefined();
  });

  test("parent tool-call dispatch_subagents leaves status empty, not a raw tool id", () => {
    const state = tuiReducer(initialTuiState(session()), {
      type: "loop-event",
      event: {
        type: "tool-call",
        name: "dispatch_subagents",
        args: { tasks: [{ role: "explore", goal: "a" }] },
      },
    });

    expect(state.status).toBe("");
    expect(state.status).not.toContain("dispatch_subagents");
  });

  test("child usage folds into the parent turn total and leaves the child row and transcript untouched", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "usage", usage: usageOf(100, 20) },
    });
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "usage",
        usage: usageOf(50, 10),
      }),
    );

    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 150,
      reconciledOutputTokens: 30,
      liveInputEstimate: 0,
      carriedOutputEstimate: 0,
      liveOutputEstimate: 0,
      exact: true,
      hasGap: false,
    });
    expect(panel(state).subagents[0]?.id).toBe("t1:0");
    expect(state.transcript).toEqual([]);
  });

  test("child compacted folds its usage into the parent turn without a compacted transcript line", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "compacted",
        summary: { goal: "g", progress: "p", blockers: "b", nextSteps: "n" },
        evictedCount: 2,
        tokensBefore: 100,
        usage: usageOf(60, 15),
      }),
    );

    expect(state.turn?.tokens).toEqual({
      reconciledInputTokens: 60,
      reconciledOutputTokens: 15,
      liveInputEstimate: 0,
      carriedOutputEstimate: 0,
      liveOutputEstimate: 0,
      exact: true,
      hasGap: false,
    });
    expect(state.transcript).toEqual([]);
  });

  test("child usage is a no-op on tokens when no turn is in flight", () => {
    let state = initialTuiState(session());
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "usage",
        usage: usageOf(50, 10),
      }),
    );

    expect(state.turn).toBeUndefined();
  });

  test("done line includes folded child usage", () => {
    let state = tuiReducer(initialTuiState(session()), {
      type: "turn-started",
      startedAt: 1,
      inputEstimate: 0,
    });
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "usage", usage: usageOf(100, 20) },
    });
    state = tuiReducer(state, childEvent("t1:0", "explore", "find a", { type: "child-started" }));
    state = tuiReducer(
      state,
      childEvent("t1:0", "explore", "find a", {
        type: "usage",
        usage: usageOf(50, 10),
      }),
    );
    const tokens = state.turn?.tokens;
    expect(tokens).toEqual({
      reconciledInputTokens: 150,
      reconciledOutputTokens: 30,
      liveInputEstimate: 0,
      carriedOutputEstimate: 0,
      liveOutputEstimate: 0,
      exact: true,
      hasGap: false,
    });
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "done", reason: "no-tool-call" },
    });

    expect(state.transcript.at(-1)?.text).toBe(`done · ${formatTokenProgress(tokens!)}`);
  });
});

// The TUI half of a `/name <task>` turn. driveLoop emits the same LoopEvents a model-issued
// dispatch does, so these assert that the reducer needs no branch for one: a file-defined agent's
// name paints the roster like a built-in's, the synthetic tool-result clears it, and the three
// appended rows land on the session the same way any other messages-updated does.
describe("tuiReducer: a /name turn's synthetic dispatch events", () => {
  test("a file-defined agent's name paints the roster with no built-in role list to belong to", () => {
    let state = initialTuiState(session());
    state = tuiReducer(
      state,
      childEvent("d1:0", "reviewer", "grade the diff", {
        type: "child-started",
      }),
    );
    expect(panel(state).subagents).toHaveLength(1);
    expect(panel(state).subagents[0]?.role).toBe("reviewer");
    expect(panel(state).subagents[0]?.goal).toBe("grade the diff");
  });

  test("the synthetic tool-result clears the roster, which is why the summary line is the evidence", () => {
    let state = initialTuiState(session());
    state = tuiReducer(
      state,
      childEvent("d1:0", "reviewer", "grade the diff", {
        type: "child-started",
      }),
    );
    state = tuiReducer(state, {
      type: "loop-event",
      event: {
        type: "tool-result",
        name: "dispatch_subagents",
        result: { results: [{ doneReason: "no-tool-call" }], totalUsage: {} },
      },
    });
    expect(panel(state).subagents).toEqual([]);
  });

  test("the three appended rows reach the session through the ordinary messages-updated path", () => {
    const state = tuiReducer(initialTuiState(session()), {
      type: "loop-event",
      event: {
        type: "messages-updated",
        messages: [
          { role: "user", content: "grade the diff" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "dispatch_subagents",
                input: { tasks: [{ role: "reviewer", goal: "grade the diff" }] },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                toolName: "dispatch_subagents",
                output: { type: "json", value: { results: [], totalUsage: {} } },
              },
            ],
          },
        ],
      },
    });
    expect(state.session.messages).toHaveLength(3);
    expect(state.session.messages[0]).toEqual({ role: "user", content: "grade the diff" });
  });
});

describe("message queue", () => {
  // Ids are cli.ts's to mint (state/reducer.ts's own note on the field), so the helper stands in
  // for it. Assertions below read `texts()` rather than `items` directly: what the queue holds is
  // the messages, and threading a synthetic id through every expectation would bury that.
  function queued(...items: string[]): TuiState {
    return items.reduce(
      (state, text, index) => tuiReducer(state, { type: "queue-appended", id: `q${index}`, text }),
      initialTuiState(session()),
    );
  }

  function texts(state: TuiState): string[] {
    return state.queue.items.map((item) => item.text);
  }

  // The invariant MessageQueue's own comment states, asserted as one function so every case below
  // can end with it instead of restating three expectations each.
  function expectInvariant(state: TuiState): void {
    const { items, selected, editing } = state.queue;
    if (items.length === 0) {
      expect({ selected, editing }).toEqual({ selected: 0, editing: false });
      return;
    }
    expect(selected).toBeGreaterThanOrEqual(0);
    expect(selected).toBeLessThan(items.length);
  }

  test("a fresh session has an empty queue", () => {
    const state = initialTuiState(session());
    expect(state.queue).toEqual({ items: [], selected: 0, editing: false });
  });

  test("the first append selects it, and a later one leaves the selection alone", () => {
    const one = queued("first");
    expect(texts(one)).toEqual(["first"]);
    expect(one.queue.selected).toBe(0);

    const moved = tuiReducer(queued("first", "second"), {
      type: "queue-selection-moved",
      delta: 1,
    });
    expect(moved.queue.selected).toBe(1);

    const appended = tuiReducer(moved, { type: "queue-appended", id: "q2", text: "third" });
    expect(appended.queue.selected).toBe(1);
    expectInvariant(appended);
  });

  test("appended text is stored exactly as typed, not trimmed", () => {
    const state = tuiReducer(initialTuiState(session()), {
      type: "queue-appended",
      id: "q0",
      text: "  indented on purpose  ",
    });
    expect(texts(state)).toEqual(["  indented on purpose  "]);
  });

  test("every queued message keeps a distinct id, which is what a row is keyed on", () => {
    const state = queued("same", "same");
    const ids = state.queue.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(2);
  });

  test("selection clamps at both ends instead of wrapping", () => {
    const top = tuiReducer(queued("a", "b"), { type: "queue-selection-moved", delta: -1 });
    expect(top.queue.selected).toBe(0);

    const bottom = [1, 1, 1].reduce(
      (state, delta) => tuiReducer(state, { type: "queue-selection-moved", delta }),
      queued("a", "b"),
    );
    expect(bottom.queue.selected).toBe(1);
    expectInvariant(bottom);
  });

  test("selection does not move on an empty queue", () => {
    const state = tuiReducer(initialTuiState(session()), {
      type: "queue-selection-moved",
      delta: 1,
    });
    expect(state.queue).toEqual({ items: [], selected: 0, editing: false });
  });

  // The retargeting bug the three no-ops exist for: without this, the band moves off the row the
  // editor is mounted on and the commit writes the edited text into a different message.
  test("selection does not move while a row is being edited", () => {
    const editing = tuiReducer(queued("a", "b"), { type: "queue-edit-started" });
    const after = tuiReducer(editing, { type: "queue-selection-moved", delta: 1 });
    expect(after.queue.selected).toBe(0);
    expect(after.queue.editing).toBe(true);
  });

  test("a drop is refused while a row is being edited", () => {
    const editing = tuiReducer(queued("a", "b"), { type: "queue-edit-started" });
    const after = tuiReducer(editing, { type: "queue-item-dropped" });
    expect(texts(after)).toEqual(["a", "b"]);
    expect(after.queue.editing).toBe(true);
  });

  test("edit-started is refused on an empty queue and while already editing", () => {
    const empty = tuiReducer(initialTuiState(session()), { type: "queue-edit-started" });
    expect(empty.queue.editing).toBe(false);

    const editing = tuiReducer(queued("a"), { type: "queue-edit-started" });
    expect(tuiReducer(editing, { type: "queue-edit-started" })).toBe(editing);
  });

  test("a commit replaces the selected row in place and ends the edit", () => {
    const editing = tuiReducer(
      tuiReducer(queued("a", "b"), { type: "queue-selection-moved", delta: 1 }),
      { type: "queue-edit-started" },
    );
    const after = tuiReducer(editing, { type: "queue-edit-committed", text: "b, revised" });
    expect(texts(after)).toEqual(["a", "b, revised"]);
    expect(after.queue.selected).toBe(1);
    expect(after.queue.editing).toBe(false);
  });

  test("an edited row keeps its id, so the editor is not remounted underneath the edit", () => {
    const editing = tuiReducer(queued("a"), { type: "queue-edit-started" });
    const before = editing.queue.items[0].id;
    const after = tuiReducer(editing, { type: "queue-edit-committed", text: "revised" });
    expect(after.queue.items[0].id).toBe(before);
  });

  test("a blank commit keeps the original text and still ends the edit", () => {
    const editing = tuiReducer(queued("a"), { type: "queue-edit-started" });
    const after = tuiReducer(editing, { type: "queue-edit-committed", text: "   " });
    expect(texts(after)).toEqual(["a"]);
    expect(after.queue.editing).toBe(false);
  });

  test("a cancelled edit leaves the text untouched", () => {
    const editing = tuiReducer(queued("a"), { type: "queue-edit-started" });
    const after = tuiReducer(editing, { type: "queue-edit-cancelled" });
    expect(texts(after)).toEqual(["a"]);
    expect(after.queue.editing).toBe(false);
  });

  test("a drop renumbers the rest and clamps the selection to the new last row", () => {
    const onLast = [1, 1].reduce(
      (state, delta) => tuiReducer(state, { type: "queue-selection-moved", delta }),
      queued("a", "b", "c"),
    );
    expect(onLast.queue.selected).toBe(2);

    const after = tuiReducer(onLast, { type: "queue-item-dropped" });
    expect(texts(after)).toEqual(["a", "b"]);
    expect(after.queue.selected).toBe(1);
    expectInvariant(after);
  });

  test("dropping the last row returns the empty shape rather than a stale selection", () => {
    const after = tuiReducer(queued("only"), { type: "queue-item-dropped" });
    expect(after.queue).toEqual({ items: [], selected: 0, editing: false });
  });

  // `selected - 1` rather than `selected`: every remaining row shifted up by one, so the band has
  // to follow the message it was on rather than slide onto the next one down.
  test("taking the head keeps the band on the same message", () => {
    const onSecond = tuiReducer(queued("a", "b", "c"), {
      type: "queue-selection-moved",
      delta: 1,
    });
    const after = tuiReducer(onSecond, { type: "queue-head-taken" });
    expect(texts(after)).toEqual(["b", "c"]);
    expect(after.queue.selected).toBe(0);
    expectInvariant(after);
  });

  test("taking the head while it is selected clamps back to the new head", () => {
    const after = tuiReducer(queued("a", "b"), { type: "queue-head-taken" });
    expect(texts(after)).toEqual(["b"]);
    expect(after.queue.selected).toBe(0);
  });

  test("taking the only queued message empties the queue", () => {
    const after = tuiReducer(queued("only"), { type: "queue-head-taken" });
    expect(after.queue).toEqual({ items: [], selected: 0, editing: false });
  });

  test("the queue survives a turn ending, which is the whole point of it", () => {
    const state = tuiReducer(queued("next up"), { type: "turn-ended" });
    expect(texts(state)).toEqual(["next up"]);
  });
});

describe("tuiReducer: reasoning spans", () => {
  function withUser(state = initialTuiState(session())) {
    return tuiReducer(state, {
      type: "transcript-append",
      line: "> check the spec",
      role: "user",
    });
  }

  test("a reasoning span settles on the first tool-call with span time only", () => {
    const now = spyOn(Date, "now");
    now.mockReturnValue(1_000);
    let state = withUser();
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "reasoning-delta", text: "start at ROADMAP" },
    });
    now.mockReturnValue(5_000);
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "tool-call", name: "read_file", args: { path: "docs/ROADMAP.md" } },
    });
    now.mockRestore();

    const rows = state.transcript.filter((entry) => entry.kind === "reasoning");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "system",
      muted: true,
      kind: "reasoning",
      body: "start at ROADMAP",
      text: "▸ thought · 4s",
    });
    expect(rows[0]?.text).not.toContain("↑");
    expect(state.reasoning.live).toBeUndefined();
  });

  test("a reasoning span settles on done when there is no tool-call", () => {
    const now = spyOn(Date, "now");
    now.mockReturnValue(1_000);
    let state = withUser();
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "reasoning-delta", text: "no tools needed" },
    });
    now.mockReturnValue(3_000);
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "done", reason: "no-tool-call" },
    });
    now.mockRestore();

    expect(state.transcript.filter((entry) => entry.kind === "reasoning")).toHaveLength(1);
    expect(state.transcript.find((entry) => entry.kind === "reasoning")?.text).toBe(
      "▸ thought · 2s",
    );
  });

  test("a second span after a tool is a second row", () => {
    const now = spyOn(Date, "now");
    now.mockReturnValue(1_000);
    let state = withUser();
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "reasoning-delta", text: "first" },
    });
    now.mockReturnValue(2_000);
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "tool-call", name: "read_file", args: {} },
    });
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "tool-result", name: "read_file", result: "ok" },
    });
    now.mockReturnValue(3_000);
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "reasoning-delta", text: "second" },
    });
    now.mockReturnValue(6_000);
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "done", reason: "no-tool-call" },
    });
    now.mockRestore();

    const rows = state.transcript.filter((entry) => entry.kind === "reasoning");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.body).toBe("first");
    expect(rows[1]?.body).toBe("second");
    expect(rows[1]?.text).toBe("▸ thought · 3s");
  });

  test("a second think after a tool keeps two carets; done drops the tree", () => {
    const now = spyOn(Date, "now");
    now.mockReturnValue(1_000);
    let state = withUser();
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "reasoning-delta", text: "first" },
    });
    now.mockReturnValue(2_000);
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "tool-call", name: "read_file", args: { path: "docs/ROADMAP.md" } },
    });
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "tool-result", name: "read_file", result: "ok" },
    });
    now.mockReturnValue(3_000);
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "reasoning-delta", text: "second" },
    });
    now.mockReturnValue(6_000);
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: "052 shipped" },
    });
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "done", reason: "no-tool-call" },
    });
    now.mockRestore();

    const kinds = state.transcript.map((entry) =>
      entry.kind === "reasoning" ? `thought:${entry.body}` : `${entry.role}:${entry.text}`,
    );
    const thoughtIdx = kinds.findIndex((line) => line === "thought:first");
    const thought2Idx = kinds.findIndex((line) => line === "thought:second");
    const answerIdx = kinds.findIndex((line) => line.startsWith("assistant:"));
    const doneIdx = kinds.findIndex(
      (line) => line === "system:done" || line.startsWith("system:done ·"),
    );
    expect(thoughtIdx).toBeGreaterThanOrEqual(0);
    expect(thought2Idx).toBeGreaterThan(thoughtIdx);
    expect(answerIdx).toBeGreaterThan(thought2Idx);
    expect(doneIdx).toBeGreaterThan(answerIdx);
    expect(kinds.some((line) => line.includes("→ Read"))).toBe(false);
    expect(kinds).toContain("system:Read 1 file");
    expect(state.toolActivity).toEqual([]);
  });

  test("no reasoning-delta leaves today's transcript with no caret", () => {
    let state = withUser();
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: "just an answer" },
    });
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "done", reason: "no-tool-call" },
    });

    expect(state.transcript.some((entry) => entry.kind === "reasoning")).toBe(false);
    expect(state.transcript.some((entry) => entry.text.includes("thought"))).toBe(false);
  });

  test("opening a thought does not commit the answer buffer", () => {
    let state = withUser();
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "reasoning-delta", text: "thinking" },
    });
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "text-delta", text: "the secret answer" },
    });
    expect(state.streaming).toBe("the secret answer");
    expect(state.transcript.some((entry) => entry.text.includes("the secret answer"))).toBe(false);

    state = tuiReducer(state, { type: "reasoning-toggled" });
    expect(state.streaming).toBe("the secret answer");
    expect(state.transcript.some((entry) => entry.text.includes("the secret answer"))).toBe(false);
    const thought = state.transcript.find((entry) => entry.kind === "reasoning");
    expect(thought?.expanded).toBe(true);
    expect(thought?.body).toBe("thinking");
  });

  test("transcript-cleared and turn-started drop a live span", () => {
    let state = withUser();
    state = tuiReducer(state, {
      type: "loop-event",
      event: { type: "reasoning-delta", text: "ephemeral" },
    });
    expect(state.reasoning.live?.text).toBe("ephemeral");

    const cleared = tuiReducer(state, { type: "transcript-cleared" });
    expect(cleared.reasoning).toEqual({ expanded: false });
    expect(cleared.transcript).toEqual([]);

    const nextTurn = tuiReducer(state, { type: "turn-started", startedAt: 1, inputEstimate: 0 });
    expect(nextTurn.reasoning).toEqual({ expanded: false });
  });
});
