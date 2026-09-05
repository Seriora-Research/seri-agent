import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { buildSystemPrompt } from "../../src/agents/systemPrompt";
import { ASK_USER_OVERLAY } from "../../src/ask-user/prompt";
import { ASK_USER_TOOL_NAME } from "../../src/ask-user/types";
import { loadVerifyConfig } from "../../src/config/config";
import type { HookRegistry, HookSpec } from "../../src/hooks/types";
import type { LoopEvent, runLoop } from "../../src/loop/loop";
import { createMcpClients } from "../../src/mcp/client";
import { toolFingerprint } from "../../src/mcp/registry";
import { MCP_TOOL_NAME, mcpCallSubject } from "../../src/mcp/tool";
import { type McpCatalog, type McpToolInfo, mcpGrantMatches } from "../../src/mcp/types";
import { createArchivistState } from "../../src/memory/archivist";
import { loadMemory } from "../../src/memory/store";
import { loadGrants } from "../../src/permissions/store";
import { PLAN_MODE_OVERLAY } from "../../src/plan/prompt";
import { ASK_PLAN_QUESTIONS_TOOL_NAME, SUBMIT_PLAN_TOOL_NAME } from "../../src/plan/tools";
import { DISPATCH_TOOL_NAME, toolDefinitions } from "../../src/provider/tools";
import { TODO_TOOL_NAME } from "../../src/todo/tool";
import { driveLoop, exitCodeFromDriveResult } from "../../src/runtime/drive";
import type { PreparedRun } from "../../src/runtime/prepare";
import type { SessionState } from "../../src/session/session";
import { deliverSignal, onSignalCancel } from "../../src/signals";
import type { ChildEventPayload } from "../../src/subagents/dispatch";
import { type AgentSpec, builtinRegistry, composeAddendum } from "../../src/subagents/registry";
import { fakeRunLoop } from "../cli/fakeRunLoop";

type RunLoopOpts = Parameters<typeof runLoop>[0];

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
      credential: "key",
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
      setStepCeiling: () => {},
    },
    skills: new Map(),
    rules: new Map(),
    rulesState: { fired: new Set<string>() },
    hooks: { registry: new Map() },
    mcp: new Map(),
    mcpClients: createMcpClients(),
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
  test("composeSubagents false omits dispatch_subagents and todo; the default still adds both", async () => {
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
    expect(TODO_TOOL_NAME in (withDispatch.capture()?.tools ?? {})).toBe(true);

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
    expect(TODO_TOOL_NAME in (withoutDispatch.capture()?.tools ?? {})).toBe(false);
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
  // Built-in explore/plan and a file-defined agent are registry entries alike, so `/explore …`
  // reaches this path with no source change; a file-defined agent reaches it identically.
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

  // A child's tool calls never reach the parent's runLoop, so a PreToolUse hook is only a rail for
  // a child if the SubagentRuntime carries the runner down — which is why this asserts on the opts
  // the CHILD loop was handed rather than on anything the parent did. A dispatch is the vehicle
  // because it is the shortest one: `/name` runs exactly one child and no parent model call, so
  // the single captured opts object is the child's.
  //
  // The matcher is written to match nothing, so the runner is exercised without spawning anything:
  // a real HookRunner short-circuits on hookMatches and resolves `{ errors: [] }`, where any other
  // function of that shape would not. The empty-registry half is the negative control — without it
  // this test would pass identically against a wiring that always passed some callback down.
  test("a session with a PreToolUse hook hands the runner down to the child loop", async () => {
    const spec: HookSpec = {
      event: "PreToolUse",
      script: "guard",
      path: "/p/.seri/hooks/guard.sh",
      matcher: /^matches_no_tool$/,
      timeoutMs: 1000,
      source: "project",
      filePath: "/p/.seri/hooks/hooks.yaml",
    };

    async function childSees(registry: HookRegistry) {
      const prepared = preparedStub();
      prepared.hooks = { registry };
      let before: Awaited<ReturnType<NonNullable<RunLoopOpts["onBeforeTool"]>>> | undefined;
      let sawOpt = false;
      await driveLoop(
        prepared,
        unusedCtx(prepared.session.cwd),
        {
          runLoop: async function* (opts) {
            sawOpt = opts.onBeforeTool !== undefined;
            before = await opts.onBeforeTool?.("bash", { command: "rm -rf /" });
            yield { type: "done", reason: "no-tool-call" as const };
            return opts.messages;
          },
        },
        1,
        () => {},
        () => "auto",
        () => {},
        async () => "no",
        createArchivistState(prepared.session),
        undefined,
        { directDispatch: { agent: reviewer(), goal: "grade the diff" }, runArchivist: false },
      );
      return { sawOpt, before };
    }

    expect(await childSees(new Map([["PreToolUse", [spec]]]))).toEqual({
      sawOpt: true,
      before: { errors: [] },
    });
    expect(await childSees(new Map())).toEqual({ sawOpt: false, before: undefined });
  });
});

describe("driveLoop mcp composition", () => {
  function mcpRegistryWith(tool: McpToolInfo) {
    const catalog: McpCatalog = {
      server: "exa",
      fetchedAt: new Date().toISOString(),
      tools: [tool],
    };
    return new Map([
      [
        "exa",
        {
          spec: {
            name: "exa",
            url: "https://mcp.exa.ai/mcp",
            headers: {},
            source: "project" as const,
            filePath: "x",
          },
          catalog,
        },
      ],
    ]);
  }

  const searchTool: McpToolInfo = {
    name: "web_search",
    toolName: "mcp_exa_web_search",
    description: "Search the web.",
    inputSchema: {},
  };

  // Seen red first: with `withMcp(...)` deleted from the tools composition in runtime/drive.ts,
  // MCP_TOOL_NAME never appears in what runLoop is handed, regardless of what prepared.mcp holds.
  test("composes the mcp tool from prepared.mcp and passes mcpCallSubject as callSubject", async () => {
    const prepared = preparedStub();
    prepared.mcp = mcpRegistryWith(searchTool);
    const ctx = unusedCtx(prepared.session.cwd);
    const { fake, capture } = fakeRunLoop();
    await driveLoop(
      prepared,
      ctx,
      { runLoop: fake },
      1,
      () => {},
      () => "read-only",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
    );
    expect(MCP_TOOL_NAME in (capture()?.tools ?? {})).toBe(true);
    expect(capture()?.callSubject).toBe(mcpCallSubject);
  });

  // Seen red first: with the trailing `grantFingerprint(prepared.mcp, event.name)` argument
  // removed from the rememberGrant call in runtime/drive.ts, the MCP entry below is refused
  // (rememberGrant requires a fingerprint for an mcp_ name) and this test's own `mcpEntry` search
  // finds nothing.
  test("a tool-allowed event persists write_file with no fingerprint and an mcp tool with one", async () => {
    const prepared = preparedStub();
    prepared.mcp = mcpRegistryWith(searchTool);
    const ctx = unusedCtx(prepared.session.cwd);
    const { fake } = fakeRunLoop([
      { type: "tool-allowed", name: "write_file" },
      { type: "tool-allowed", name: "mcp_exa_web_search" },
      { type: "done", reason: "no-tool-call" },
    ]);
    await driveLoop(
      prepared,
      ctx,
      { runLoop: fake },
      1,
      () => {},
      () => "approve-each",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
    );

    const grants = loadGrants(ctx.permissionsDir, prepared.worktree);
    const all = [...grants.global, ...grants.project];
    expect(all).toContain("write_file");
    const mcpEntry = all.find((entry) => entry.startsWith("mcp_exa_web_search@"));
    expect(mcpEntry).toBeDefined();
    expect(mcpGrantMatches(mcpEntry as string, toolFingerprint(searchTool))).toBe(true);
  });

  test("a llama catalog family injects the tool-use overlay into the assembled system; gpt-oss does not", async () => {
    const llama = preparedStub();
    llama.catalogEntry = {
      id: "llama-3.3-70b-versatile",
      provider: "groq",
      displayName: "Llama 3.3 70B Versatile",
      family: "llama",
      contextWindow: 131072,
      maxOutputTokens: 32768,
      toolCall: true,
      reasoning: false,
      pricing: undefined,
    };
    llama.route = { ...llama.route, model: "llama-3.3-70b-versatile" };
    const llamaCapture = fakeRunLoop();
    await driveLoop(
      llama,
      unusedCtx(llama.session.cwd),
      { runLoop: llamaCapture.fake },
      1,
      () => {},
      () => "read-only",
      () => {},
      async () => "no",
      createArchivistState(llama.session),
      undefined,
      { composeSubagents: false, bindProcessCancel: false },
    );
    expect(llamaCapture.capture()?.system).toMatch(/text that looks like a call is not a call/i);

    const oss = preparedStub();
    oss.catalogEntry = {
      id: "openai/gpt-oss-120b",
      provider: "groq",
      displayName: "GPT OSS 120B",
      family: "gpt-oss",
      contextWindow: 131072,
      maxOutputTokens: 32768,
      toolCall: true,
      reasoning: false,
      pricing: undefined,
    };
    const ossCapture = fakeRunLoop();
    await driveLoop(
      oss,
      unusedCtx(oss.session.cwd),
      { runLoop: ossCapture.fake },
      1,
      () => {},
      () => "read-only",
      () => {},
      async () => "no",
      createArchivistState(oss.session),
      undefined,
      { composeSubagents: false, bindProcessCancel: false },
    );
    expect(ossCapture.capture()?.system).not.toMatch(/text that looks like a call is not a call/i);
  });

  test("permission mode does not change the assembled system or invert dedicated file tools", async () => {
    const bashFirstPhrases = [
      "Do your work through the Bash tool",
      "rather than using the dedicated",
      "While bypass permissions mode is active",
    ] as const;
    const systemPrompt = buildSystemPrompt({ agentsContent: "", skills: [], rules: [] });

    async function driveWith(mode: "auto" | "approve-each" | "read-only"): Promise<string> {
      const prepared = preparedStub();
      prepared.session.systemPrompt = systemPrompt;
      const capture = fakeRunLoop();
      await driveLoop(
        prepared,
        unusedCtx(prepared.session.cwd),
        { runLoop: capture.fake },
        1,
        () => {},
        () => mode,
        () => {},
        async () => "no",
        createArchivistState(prepared.session),
        undefined,
        { composeSubagents: false, runArchivist: false, bindProcessCancel: false },
      );
      const system = capture.capture()?.system;
      expect(system).toBeDefined();
      return system as string;
    }

    const auto = await driveWith("auto");
    const approveEach = await driveWith("approve-each");
    expect(auto).toBe(approveEach);
    expect(auto).toMatch(/prefer[\s\S]{0,80}dedicated tools[\s\S]{0,80}shell/i);
    expect(auto).toMatch(/read_file[\s\S]{0,40}instead of[\s\S]{0,20}cat/i);
    for (const phrase of bashFirstPhrases) {
      expect(auto).not.toMatch(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    }

    const readOnly = await driveWith("read-only");
    expect(auto).toBe(readOnly);
  });
});

describe("driveLoop planMode", () => {
  function withWriteTools(): PreparedRun {
    const prepared = preparedStub();
    prepared.tools = {
      write_file: toolDefinitions.write_file,
      read_file: toolDefinitions.read_file,
    };
    return prepared;
  }

  test("composes plan tools, strips writes, joins the overlay, and sets terminalTools", async () => {
    const prepared = withWriteTools();
    const capture = fakeRunLoop();
    await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      { runLoop: capture.fake },
      1,
      () => {},
      () => "auto",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      {
        composeSubagents: false,
        runArchivist: false,
        bindProcessCancel: false,
        planMode: {
          askQuestions: async () => ({ cancelled: true }),
          configDir: prepared.session.cwd,
        },
      },
    );
    const opts = capture.capture();
    expect(opts?.tools[ASK_PLAN_QUESTIONS_TOOL_NAME]).toBeDefined();
    expect(opts?.tools[SUBMIT_PLAN_TOOL_NAME]).toBeDefined();
    expect(opts?.tools.write_file).toBeUndefined();
    expect(opts?.tools.read_file).toBeDefined();
    expect(opts?.system).toContain(PLAN_MODE_OVERLAY.slice(0, 40));
    expect(PLAN_MODE_OVERLAY).not.toMatch(/do your work through the bash tool/i);
    expect(PLAN_MODE_OVERLAY).not.toMatch(/rather than using the dedicated/i);
    expect(PLAN_MODE_OVERLAY).not.toMatch(/while bypass permissions mode is active/i);
    expect(opts?.terminalTools).toEqual(new Set([SUBMIT_PLAN_TOOL_NAME]));
  });

  test("without planMode the parent ToolSet has neither plan tool nor the overlay", async () => {
    const prepared = withWriteTools();
    const capture = fakeRunLoop();
    await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      { runLoop: capture.fake },
      1,
      () => {},
      () => "auto",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      { composeSubagents: false, runArchivist: false, bindProcessCancel: false },
    );
    const opts = capture.capture();
    expect(opts?.tools[ASK_PLAN_QUESTIONS_TOOL_NAME]).toBeUndefined();
    expect(opts?.tools[SUBMIT_PLAN_TOOL_NAME]).toBeUndefined();
    expect(opts?.tools.write_file).toBeDefined();
    expect(opts?.system).not.toContain("You are in plan mode");
    expect(opts?.terminalTools).toBeUndefined();
  });

  test("a submit_plan tool-result is returned as submittedPlan", async () => {
    const prepared = withWriteTools();
    const plan = { path: "/tmp/p.md", title: "T", markdown: "# T\n" };
    const capture = fakeRunLoop([
      { type: "tool-result", name: SUBMIT_PLAN_TOOL_NAME, result: plan },
      { type: "done", reason: "plan-submitted" },
    ]);
    const result = await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      { runLoop: capture.fake },
      1,
      () => {},
      () => "auto",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      {
        composeSubagents: false,
        runArchivist: false,
        bindProcessCancel: false,
        planMode: {
          askQuestions: async () => ({ cancelled: true }),
          configDir: prepared.session.cwd,
        },
      },
    );
    expect(result.doneReason).toBe("plan-submitted");
    expect(result.submittedPlan).toEqual(plan);
  });
});

describe("driveLoop ask_user", () => {
  test("default composes ask_user and joins the overlay; composeAskUser false omits both", async () => {
    const prepared = preparedStub();
    const withAsk = fakeRunLoop();
    await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      { runLoop: withAsk.fake },
      1,
      () => {},
      () => "auto",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      { composeSubagents: false, runArchivist: false, bindProcessCancel: false },
    );
    expect(withAsk.capture()?.tools[ASK_USER_TOOL_NAME]).toBeDefined();
    expect(withAsk.capture()?.system).toContain(ASK_USER_OVERLAY.slice(0, 40));

    const withoutAsk = fakeRunLoop();
    await driveLoop(
      preparedStub(),
      unusedCtx(prepared.session.cwd),
      { runLoop: withoutAsk.fake },
      1,
      () => {},
      () => "auto",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      {
        composeSubagents: false,
        runArchivist: false,
        bindProcessCancel: false,
        composeAskUser: false,
      },
    );
    expect(withoutAsk.capture()?.tools[ASK_USER_TOOL_NAME]).toBeUndefined();
    expect(withoutAsk.capture()?.system).not.toContain("call `ask_user`");
  });

  test("a missing presenter returns unavailable without hanging", async () => {
    const prepared = preparedStub();
    const capture = fakeRunLoop();
    await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      { runLoop: capture.fake },
      1,
      () => {},
      () => "auto",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      { composeSubagents: false, runArchivist: false, bindProcessCancel: false },
    );
    const ask = capture.capture()?.tools[ASK_USER_TOOL_NAME];
    const pending = ask?.execute?.(
      { prompt: "Which?", choices: ["a", "b"] },
      { toolCallId: "t", messages: [], context: {} },
    );
    const raced = await Promise.race([
      Promise.resolve(pending).then(() => "done" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    expect(raced).toBe("done");
    expect(await pending).toEqual({ outcome: "unavailable", reason: "no-human" });
  });

  test("plan mode keeps ask_user alongside the plan tools", async () => {
    const prepared = preparedStub();
    const capture = fakeRunLoop();
    await driveLoop(
      prepared,
      unusedCtx(prepared.session.cwd),
      { runLoop: capture.fake },
      1,
      () => {},
      () => "auto",
      () => {},
      async () => "no",
      createArchivistState(prepared.session),
      undefined,
      {
        composeSubagents: false,
        runArchivist: false,
        bindProcessCancel: false,
        planMode: {
          askQuestions: async () => ({ cancelled: true }),
          configDir: prepared.session.cwd,
        },
      },
    );
    const opts = capture.capture();
    expect(opts?.tools[ASK_USER_TOOL_NAME]).toBeDefined();
    expect(opts?.tools[ASK_PLAN_QUESTIONS_TOOL_NAME]).toBeDefined();
  });
});

describe("exitCodeFromDriveResult", () => {
  const base = {
    cancelledBy: undefined,
    usage: { inputTokens: undefined, outputTokens: undefined },
    cost: undefined,
    refusedWithoutRunning: false,
    archivist: undefined,
    directSummary: undefined,
    ranAnyTurn: true,
  };

  test("plan-submitted is success", () => {
    expect(exitCodeFromDriveResult({ ...base, doneReason: "plan-submitted" })).toBe(0);
  });

  test("no-tool-call is success unless every write was declined", () => {
    expect(exitCodeFromDriveResult({ ...base, doneReason: "no-tool-call" })).toBe(0);
    expect(
      exitCodeFromDriveResult({
        ...base,
        doneReason: "no-tool-call",
        refusedWithoutRunning: true,
      }),
    ).toBe(1);
  });
});
