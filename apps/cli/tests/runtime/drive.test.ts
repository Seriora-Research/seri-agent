import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { loadVerifyConfig } from "../../src/config/config";
import type { LoopEvent } from "../../src/loop/loop";
import { createArchivistState } from "../../src/memory/archivist";
import { loadMemory } from "../../src/memory/store";
import { DISPATCH_TOOL_NAME } from "../../src/provider/tools";
import { driveLoop } from "../../src/runtime/drive";
import type { PreparedRun } from "../../src/runtime/prepare";
import type { SessionState } from "../../src/session/session";
import { deliverSignal, onSignalCancel } from "../../src/signals";
import type { ChildEventPayload } from "../../src/subagents/dispatch";
import { type AgentSpec, builtinRegistry, composeAddendum } from "../../src/subagents/registry";
import { fakeRunLoop } from "../cli/fakeRunLoop";

let dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seri-drive-opts-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function preparedStub(): PreparedRun {
  const dir = makeDir();
  return {
    session: {
      id: "sess",
      cwd: dir,
      systemPrompt: "sys",
      permissionMode: "read-only",
      model: "openai/gpt-oss-120b",
      provider: "groq",
      messages: [{ role: "user", content: "hi" }],
    },
    storeDir: dir,
    tools: {},
    model: new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream() }) }),
    permissionMode: "read-only",
    worktree: dir,
    allowedTools: [],
    catalog: { fetchedAt: "", entries: [] },
    catalogEntry: undefined,
    route: {
      model: "openai/gpt-oss-120b",
      provider: "groq",
      rerouted: false,
      viaGateway: false,
    },
    plan: null,
    checkpointer: Object.assign(() => {}, {
      onAfterMutation: () => {},
      invalidate: () => {},
    }),
    verifyConfig: loadVerifyConfig(dir),
    memory: loadMemory({ configDir: dir, worktree: dir }),
    agents: builtinRegistry(),
    trajectory: {
      recordLoopEvent: () => {},
      recordChildUsage: () => {},
      recordChildEvent: () => {},
      recordCheckpoint: () => {},
      recordArchivist: () => {},
      setEnabled: () => {},
      isEnabled: () => true,
    },
    skills: new Map(),
    preMountMessages: [],
  };
}

function unusedCtx(configDir: string) {
  return {
    resuming: false as const,
    resumeId: undefined,
    taskText: "hi",
    sessionsDir: join(configDir, "sessions"),
    checkpointsDir: join(configDir, "checkpoints"),
    permissionsDir: configDir,
    configDir,
    cwd: configDir,
  };
}

describe("driveLoop options", () => {
  test("composeSubagents false omits dispatch_subagents; the default still adds it", async () => {
    const prepared = preparedStub();
    const ctx = unusedCtx(prepared.session.cwd);
    const emptyArchivist = createArchivistState(prepared.session);
    const withDispatch = fakeRunLoop();
    await driveLoop(
      prepared,
      ctx,
      { runLoop: withDispatch.fake },
      1,
      () => {},
      () => "read-only",
      () => {},
      async () => "no",
      emptyArchivist,
    );
    expect(DISPATCH_TOOL_NAME in (withDispatch.capture()?.tools ?? {})).toBe(true);

    const withoutDispatch = fakeRunLoop();
    await driveLoop(
      preparedStub(),
      ctx,
      { runLoop: withoutDispatch.fake },
      1,
      () => {},
      () => "read-only",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      { composeSubagents: false },
    );
    expect(DISPATCH_TOOL_NAME in (withoutDispatch.capture()?.tools ?? {})).toBe(false);
  });

  test("bindProcessCancel false leaves the process cancel slot untouched", async () => {
    let preserved = false;
    const unregister = onSignalCancel(() => {
      preserved = true;
    });
    try {
      const prepared = preparedStub();
      await driveLoop(
        prepared,
        unusedCtx(prepared.session.cwd),
        { runLoop: fakeRunLoop().fake },
        1,
        () => {},
        () => "read-only",
        () => {},
        async () => "no",
        createArchivistState(prepared.session),
        undefined,
        { bindProcessCancel: false },
      );
      deliverSignal("SIGINT");
      expect(preserved).toBe(true);
    } finally {
      unregister();
    }
  });

  test("an injected signal aborts the same controller the loop is driven with", async () => {
    const abort = new AbortController();
    const prepared = preparedStub();
    let loopSignal: AbortSignal | undefined;
    const loop = driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      {
        runLoop: async function* (opts) {
          loopSignal = opts.signal;
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) resolve();
            else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "done", reason: "aborted" as const };
        },
      },
      1,
      () => {},
      () => "read-only",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      { signal: abort.signal, bindProcessCancel: false },
    );
    abort.abort();
    const result = await loop;
    expect(result.doneReason).toBe("aborted");
    expect(loopSignal?.aborted).toBe(true);
  });

  test("runArchivist false does not invoke the archivist child", async () => {
    const prepared = preparedStub();
    let recorded = 0;
    prepared.trajectory.recordArchivist = () => {
      recorded += 1;
    };
    await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      { runLoop: fakeRunLoop().fake },
      1,
      () => {},
      () => "read-only",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      { composeSubagents: false, runArchivist: false },
    );
    expect(recorded).toBe(0);
  });
});

describe("driveLoop directDispatch", () => {
  // The five parent-callable agents are registry entries like any other, so `/explore …` reaches
  // this path with no source change; a file-defined agent reaches it identically.
  function reviewer(): AgentSpec {
    const toolNames = ["read_file", "grep"] as const;
    return {
      name: "reviewer",
      description: "Grades a diff.",
      toolNames,
      addendum: composeAddendum({ name: "reviewer", job: "review it", toolNames }),
      request: undefined,
      source: "project",
      filePath: "/p/.seri/agents/reviewer.md",
    };
  }

  function runDirect(
    childEvents: LoopEvent[],
    onEvent: (event: LoopEvent) => void = () => {},
    persist: (session: SessionState<ModelMessage>) => void = () => {},
  ) {
    const prepared = preparedStub();
    const child = fakeRunLoop(childEvents);
    return {
      prepared,
      child,
      run: driveLoop(
        prepared,
        unusedCtx(prepared.session.cwd),
        { runLoop: child.fake },
        1,
        onEvent,
        () => "auto",
        persist,
        async () => "no",
        createArchivistState(prepared.session),
        undefined,
        { directDispatch: { agent: reviewer(), goal: "grade the diff" }, runArchivist: false },
      ),
    };
  }

  test("appends a user row, a dispatch tool-call row and its tool-result row, in that order", async () => {
    const persisted: SessionState<ModelMessage>[] = [];
    const { run } = runDirect(
      [
        { type: "text-delta", text: "HIGH - the parser drops an empty tools list" },
        { type: "done", reason: "no-tool-call" },
      ],
      () => {},
      (session) => persisted.push(session),
    );
    await run;

    // The three rows this dispatch appended, past whatever the session already held.
    const appended = (persisted.at(-1)?.messages ?? []).slice(-3);
    expect(appended[0]).toEqual({ role: "user", content: "grade the diff" });
    expect(appended[1].role).toBe("assistant");
    expect(appended[2].role).toBe("tool");
  });

  // Providers want a user-first, alternating history, and the user row carries the plain task —
  // never the `/reviewer …` line, which is syntax the model cannot itself issue.
  test("the user row is the plain task text, and the tool-call names the agent and the goal", async () => {
    const persisted: SessionState<ModelMessage>[] = [];
    const { run } = runDirect(
      [{ type: "done", reason: "no-tool-call" }],
      () => {},
      (session) => persisted.push(session),
    );
    await run;

    const appended = (persisted.at(-1)?.messages ?? []).slice(-3);
    expect(JSON.stringify(appended[0])).not.toContain("/reviewer");
    const call = (appended[1].content as { type: string; toolName: string; input: unknown }[])[0];
    expect(call.type).toBe("tool-call");
    expect(call.toolName).toBe(DISPATCH_TOOL_NAME);
    expect(call.input).toEqual({ tasks: [{ role: "reviewer", goal: "grade the diff" }] });
  });

  test("the tool-result row carries the child's own summary back to the parent's next turn", async () => {
    const persisted: SessionState<ModelMessage>[] = [];
    const { run } = runDirect(
      [
        { type: "text-delta", text: "HIGH - the parser drops an empty tools list" },
        { type: "done", reason: "no-tool-call" },
      ],
      () => {},
      (session) => persisted.push(session),
    );
    await run;

    const appended = (persisted.at(-1)?.messages ?? []).slice(-3);
    expect(JSON.stringify(appended[2])).toContain("HIGH - the parser drops an empty tools list");
  });

  test("emits the same event stream a model-issued dispatch would, so nothing downstream branches", async () => {
    const seen: LoopEvent[] = [];
    const { run } = runDirect(
      [
        { type: "text-delta", text: "done" },
        { type: "done", reason: "no-tool-call" },
      ],
      (event) => seen.push(event),
    );
    await run;

    expect(seen.map((event) => event.type)).toEqual([
      "tool-call",
      "tool-result",
      "messages-updated",
      "done",
    ]);
  });

  test("the parent model is never called: the one runLoop call is the child's", async () => {
    const prepared = preparedStub();
    const only = fakeRunLoop();
    await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      { runLoop: only.fake },
      1,
      () => {},
      () => "auto",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      { directDispatch: { agent: reviewer(), goal: "grade the diff" }, runArchivist: false },
    );
    expect(only.capture()?.messages).toEqual([{ role: "user", content: "grade the diff" }]);
  });

  test("the child runs on the agent's own ToolSet and addendum, under the parent's system tiers", async () => {
    const { child, run } = runDirect([{ type: "done", reason: "no-tool-call" }]);
    await run;
    expect(Object.keys(child.capture()?.tools ?? {}).sort()).toEqual(["grep", "read_file"]);
    expect(child.capture()?.system).toContain('"reviewer" subagent');
  });

  test("directSummary names the agent and carries the child's summary; an ordinary turn has none", async () => {
    const { run } = runDirect([
      { type: "text-delta", text: "HIGH - the parser drops an empty tools list" },
      { type: "done", reason: "no-tool-call" },
    ]);
    const result = await run;
    expect(result.directSummary).toContain('[dispatched to the "reviewer" subagent]');
    expect(result.directSummary).toContain("HIGH - the parser drops an empty tools list");

    const prepared = preparedStub();
    const ordinary = await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      { runLoop: fakeRunLoop().fake },
      1,
      () => {},
      () => "read-only",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      { runArchivist: false },
    );
    expect(ordinary.directSummary).toBeUndefined();
  });

  test("child events reach the live roster with the agent's name on them", async () => {
    const prepared = preparedStub();
    const payloads: ChildEventPayload[] = [];
    await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      { runLoop: fakeRunLoop([{ type: "done", reason: "no-tool-call" }]).fake },
      1,
      () => {},
      () => "auto",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      (payload) => payloads.push(payload),
      { directDispatch: { agent: reviewer(), goal: "grade the diff" }, runArchivist: false },
    );
    expect(payloads.map((p) => p.event.type)).toEqual(["child-started", "done"]);
    expect(payloads[0].role).toBe("reviewer");
    expect(payloads[0].goal).toBe("grade the diff");
  });

  test("a cancel mid-child ends the turn as aborted and still writes an answered tool call", async () => {
    const prepared = preparedStub();
    const abort = new AbortController();
    const persisted: SessionState<ModelMessage>[] = [];
    const result = await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      {
        runLoop: async function* (opts) {
          abort.abort();
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) resolve();
            else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "done", reason: "aborted" as const };
        },
      },
      1,
      () => {},
      () => "auto",
      (session) => persisted.push(session),
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      {
        signal: abort.signal,
        directDispatch: { agent: reviewer(), goal: "grade the diff" },
        runArchivist: false,
      },
    );

    expect(result.doneReason).toBe("aborted");
    // An assistant tool-call with no matching tool-result is AI_MissingToolResultsError on the
    // next resume, which is the one thing a cancel must never leave behind.
    const appended = (persisted.at(-1)?.messages ?? []).slice(-3);
    expect(appended[1].role).toBe("assistant");
    expect(appended[2].role).toBe("tool");
  });

  test("a mutating agent takes the pre-dispatch snapshot, anchored where the user row lands", async () => {
    const prepared = preparedStub();
    const snapshots: { rewindTo: number }[] = [];
    prepared.checkpointer = Object.assign(
      (context: { rewindTo: number }) => snapshots.push(context),
      { onAfterMutation: () => {}, invalidate: () => {} },
    );
    const toolNames = ["read_file", "bash"] as const;
    await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      { runLoop: fakeRunLoop([{ type: "done", reason: "no-tool-call" }]).fake },
      1,
      () => {},
      () => "auto",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      {
        directDispatch: {
          agent: {
            ...reviewer(),
            name: "fixer",
            toolNames,
            addendum: composeAddendum({ name: "fixer", job: "fix it", toolNames }),
          },
          goal: "fix it",
        },
        runArchivist: false,
      },
    );
    // preparedStub's session starts with one message, so the user row this dispatch appends lands
    // at index 1 — a rewind to it undoes the whole submission, the request included.
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].rewindTo).toBe(1);
  });
});
