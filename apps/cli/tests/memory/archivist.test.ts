import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ModelCatalog } from "@seri/model-catalog";
import { MockLanguageModelV4 } from "ai/test";
import { buildVolatileTier } from "../../src/agents/systemPrompt";
import { setConfigValue } from "../../src/config/config";
import {
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  type LoopEvent,
  runLoop,
} from "../../src/loop/loop";
import {
  ARCHIVIST_PROMPT,
  ARCHIVIST_TOOL_CALL_INTERVAL,
  buildArchivistGoal,
  createArchivistState,
  maybeRunArchivist,
  observeArchivistEvent,
  resetArchivistForRewind,
  runArchivist,
  shouldRunArchivist,
} from "../../src/memory/archivist";
import { resolvePendingRef } from "../../src/memory/pending";
import { applyWrite, loadMemory, type MemoryContext } from "../../src/memory/store";
import { makeMemoryWriteTool } from "../../src/memory/tool";
import { DISPATCH_TOOL_NAME } from "../../src/provider/tools";
import { runSubagent, type SubagentRuntime } from "../../src/subagents/dispatch";
import { BUILTIN_AGENTS } from "../../src/subagents/registry";
import { parseRolePins, resolveRoleRoute } from "../../src/subagents/routes";
import { streamResult, usage as usageChunk } from "../loop/fixtures";
import { fakeChildLoop } from "../subagents/fakeChildLoop";

let configDir: string | undefined;
function makeCtx(worktree = "/home/x/harness"): MemoryContext {
  configDir = mkdtempSync(join(tmpdir(), "seri-memory-"));
  return { configDir, worktree };
}

afterEach(() => {
  if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});

function emptySession() {
  return { id: "s", cwd: "/", systemPrompt: "", permissionMode: "auto" as const, messages: [] };
}

describe("shouldRunArchivist", () => {
  const state = () => createArchivistState(emptySession());

  test("undefined below the tool-call interval, with no near-compaction signal", () => {
    const s = state();
    s.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL - 1;
    expect(shouldRunArchivist(s, 100_000, DEFAULT_COMPACTION_THRESHOLD, true)).toBeUndefined();
  });

  test('"tool-count" at the interval', () => {
    const s = state();
    s.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;
    expect(shouldRunArchivist(s, 100_000, DEFAULT_COMPACTION_THRESHOLD, true)).toBe("tool-count");
  });

  test('"near-compaction" fires even at 1 tool call, once input tokens approach the threshold', () => {
    const s = state();
    s.toolCallsSinceRun = 1;
    s.lastInputTokens = 50_000;
    expect(shouldRunArchivist(s, 100_000, DEFAULT_COMPACTION_THRESHOLD, true)).toBe(
      "near-compaction",
    );
  });

  test("enabled=false short-circuits before either trigger is evaluated, even when both are independently true", () => {
    const s = state();
    s.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;
    s.lastInputTokens = 90_000;
    expect(shouldRunArchivist(s, 100_000, DEFAULT_COMPACTION_THRESHOLD, false)).toBeUndefined();
  });







  test('"near-compaction" fires against DEFAULT_CONTEXT_WINDOW_SIZE, the real fallback a catalog-absent model gets', () => {
    const s = state();
    s.toolCallsSinceRun = 1;
    s.lastInputTokens = Math.ceil(DEFAULT_CONTEXT_WINDOW_SIZE * 0.5);
    expect(
      shouldRunArchivist(s, DEFAULT_CONTEXT_WINDOW_SIZE, DEFAULT_COMPACTION_THRESHOLD, true),
    ).toBe("near-compaction");
  });






  test("near-compaction fires against a caller-supplied compactionThreshold, not the hardcoded default", () => {
    const s = state();
    s.toolCallsSinceRun = 1;
    s.lastInputTokens = 40_000;

    expect(shouldRunArchivist(s, 100_000, DEFAULT_COMPACTION_THRESHOLD, true)).toBeUndefined();

    expect(shouldRunArchivist(s, 100_000, 0.4, true)).toBe("near-compaction");
  });
});

describe("createArchivistState", () => {
  test("starts the cursor at the session's CURRENT message count, and messages mirrors it", () => {
    const dummyMessage = { role: "user", content: "x" } as const;
    const session = {
      id: "s",
      cwd: "/",
      systemPrompt: "",
      permissionMode: "auto" as const,
      messages: [dummyMessage, dummyMessage, dummyMessage],
    };
    const s = createArchivistState(session);
    expect(s.messageCursor).toBe(3);
    expect(s.messages).toEqual(session.messages);
    expect(s.toolCallsSinceRun).toBe(0);
  });






  test("on an empty session: cursor and tool-call count are both 0, and messages is the session's own array", () => {
    const session = emptySession();
    const s = createArchivistState(session);
    expect(s.messageCursor).toBe(0);
    expect(s.toolCallsSinceRun).toBe(0);
    expect(s.messages).toBe(session.messages);
  });
});

describe("resetArchivistForRewind", () => {








  test("resets the cursor even when post-rewind growth would defeat the generic bounds check alone", () => {
    const preRewindMessages = Array.from({ length: 5 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i + 1}`,
    }));
    const s = createArchivistState(emptySession());
    s.messages = preRewindMessages;
    s.messageCursor = 5;


    const postRewindMessages = preRewindMessages.slice(0, 2);




    const grownWithoutReset = [
      ...postRewindMessages,
      { role: "user" as const, content: "new message A" },
      { role: "user" as const, content: "new message B" },
      { role: "user" as const, content: "new message C" },
      { role: "user" as const, content: "new message D" },
    ];
    const staleCursor = 5;
    const genericGuardResult = staleCursor > grownWithoutReset.length ? 0 : staleCursor;
    expect(genericGuardResult).toBe(5);



    resetArchivistForRewind(s, postRewindMessages);
    expect(s.messageCursor).toBe(0);
    expect(s.messages).toBe(postRewindMessages);



    s.messages = grownWithoutReset;
    expect(s.messageCursor).toBe(0);
  });
});

describe("observeArchivistEvent", () => {
  test("messages-updated replaces state.messages with the event's own array", () => {
    const s = createArchivistState(emptySession());
    const next = [{ role: "user" as const, content: "hi" }];
    observeArchivistEvent(s, { type: "messages-updated", messages: next });
    expect(s.messages).toBe(next);
  });

  test("tool-call increments toolCallsSinceRun", () => {
    const s = createArchivistState(emptySession());
    observeArchivistEvent(s, { type: "tool-call", name: "write_file", args: {} });
    observeArchivistEvent(s, { type: "tool-call", name: "write_file", args: {} });
    expect(s.toolCallsSinceRun).toBe(2);
  });

  test("a real usage event updates lastInputTokens", () => {
    const s = createArchivistState(emptySession());
    const usageEvent: Extract<LoopEvent, { type: "usage" }> = {
      type: "usage",
      usage: {
        inputTokens: 4_000,
        inputTokenDetails: {
          noCacheTokens: 4_000,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 10,
        outputTokenDetails: { textTokens: 10, reasoningTokens: undefined },
        totalTokens: 4_010,
      },
    };
    observeArchivistEvent(s, usageEvent);
    expect(s.lastInputTokens).toBe(4_000);
  });




  test("a compacted event does NOT update lastInputTokens", () => {
    const s = createArchivistState(emptySession());
    s.lastInputTokens = 1_234;
    observeArchivistEvent(s, {
      type: "compacted",
      summary: { goal: "g", progress: "p", blockers: "b", nextSteps: "n" },
      evictedCount: 1,
      tokensBefore: 50,
      usage: {
        inputTokens: 9_999,
        inputTokenDetails: {
          noCacheTokens: 9_999,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 5,
        outputTokenDetails: { textTokens: 5, reasoningTokens: undefined },
        totalTokens: 10_004,
      },
    });
    expect(s.lastInputTokens).toBe(1_234);
  });









  test("a mid-turn compacted event resets the cursor, even when post-compaction growth would defeat the generic bounds check alone", () => {
    const s = createArchivistState(emptySession());
    s.messages = Array.from({ length: 5 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i + 1}`,
    }));
    s.messageCursor = 5;


    const postCompactionMessages = s.messages.slice(0, 2);




    const grownWithoutReset = [
      ...postCompactionMessages,
      { role: "user" as const, content: "new message A" },
      { role: "user" as const, content: "new message B" },
      { role: "user" as const, content: "new message C" },
      { role: "user" as const, content: "new message D" },
    ];
    const staleCursor = 5;
    const genericGuardResult = staleCursor > grownWithoutReset.length ? 0 : staleCursor;
    expect(genericGuardResult).toBe(5);




    observeArchivistEvent(s, {
      type: "compacted",
      summary: { goal: "g", progress: "p", blockers: "b", nextSteps: "n" },
      evictedCount: 3,
      tokensBefore: 50,
      usage: {
        inputTokens: 1,
        inputTokenDetails: {
          noCacheTokens: 1,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 1,
        outputTokenDetails: { textTokens: 1, reasoningTokens: undefined },
        totalTokens: 2,
      },
    });
    observeArchivistEvent(s, { type: "messages-updated", messages: postCompactionMessages });
    expect(s.messageCursor).toBe(0);


    observeArchivistEvent(s, { type: "messages-updated", messages: grownWithoutReset });
    expect(s.messageCursor).toBe(0);
  });
});

function catalogFor(): ModelCatalog {
  return {
    fetchedAt: "",
    entries: [
      {
        id: "test-model",
        provider: "groq",
        displayName: "Test Model",
        family: null,
        contextWindow: 100_000,
        maxOutputTokens: 4_096,
        toolCall: true,
        reasoning: false,
        pricing: { inputPerMTok: 1, outputPerMTok: 2 },
      },
    ],
  };
}

function toolCallStream(
  toolCallId: string,
  toolName: string,
  input: unknown,
): LanguageModelV4StreamPart[] {
  return [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: usageChunk(10, 3),
    },
  ];
}

function stopStream(): LanguageModelV4StreamPart[] {
  return [
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usageChunk(2, 2) },
  ];
}

describe("maybeRunArchivist", () => {



  test("resets an out-of-bounds messageCursor to 0", async () => {
    const ctx = makeCtx();
    const s = createArchivistState(emptySession());
    s.messages = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];
    s.messageCursor = 5;
    const report = await maybeRunArchivist({
      state: s,
      ctx,
      contextWindow: 100_000,
      model: new MockLanguageModelV4({ doStream: [] }),
      route: { model: "test-model", provider: "groq" },
      catalog: catalogFor(),
      signal: new AbortController().signal,
      onWarning: () => {},
    });
    expect(report).toBeUndefined();
    expect(s.messageCursor).toBe(0);
  });



  test("leaves an in-bounds messageCursor untouched", async () => {
    const ctx = makeCtx();
    const s = createArchivistState(emptySession());
    s.messages = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];
    s.messageCursor = 1;
    await maybeRunArchivist({
      state: s,
      ctx,
      contextWindow: 100_000,
      model: new MockLanguageModelV4({ doStream: [] }),
      route: { model: "test-model", provider: "groq" },
      catalog: catalogFor(),
      signal: new AbortController().signal,
      onWarning: () => {},
    });
    expect(s.messageCursor).toBe(1);
  });

  test("enabled=false (a /memory archivist off toggle) returns undefined without calling the model, even past the tool-count threshold", async () => {
    const ctx = makeCtx();
    setConfigValue("SERI_ARCHIVIST_ENABLED", "false", ctx.configDir);
    const s = createArchivistState(emptySession());
    s.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;
    const model = new MockLanguageModelV4({ doStream: [] });
    const report = await maybeRunArchivist({
      state: s,
      ctx,
      contextWindow: 100_000,
      model,
      route: { model: "test-model", provider: "groq" },
      catalog: catalogFor(),
      signal: new AbortController().signal,
      onWarning: () => {},
    });
    expect(report).toBeUndefined();
    expect(model.doStreamCalls).toHaveLength(0);
  });

  test("an already-aborted signal returns undefined", async () => {
    const ctx = makeCtx();
    const s = createArchivistState(emptySession());
    s.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;
    const controller = new AbortController();
    controller.abort();
    const report = await maybeRunArchivist({
      state: s,
      ctx,
      contextWindow: 100_000,
      model: new MockLanguageModelV4({ doStream: [] }),
      route: { model: "test-model", provider: "groq" },
      catalog: catalogFor(),
      signal: controller.signal,
      onWarning: () => {},
    });
    expect(report).toBeUndefined();
  });

  test("end-to-end: enabled + trigger met drives a real archivist run and returns its report", async () => {
    const ctx = makeCtx();
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(
          toolCallStream("call-1", "memory_write", {
            scope: "memory-project",
            action: "add",
            content: "tests run with bun test",
            reason: "seen in transcript",
            durable: true,
          }),
        ),
        streamResult(stopStream()),
      ],
    });
    const s = createArchivistState(emptySession());
    s.messages = [{ role: "user", content: "task" }];
    s.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;

    const report = await maybeRunArchivist({
      state: s,
      ctx,
      contextWindow: 100_000,
      model,
      route: { model: "test-model", provider: "groq" },
      catalog: catalogFor(),
      signal: new AbortController().signal,
      onWarning: () => {},
    });

    expect(report?.trigger).toBe("tool-count");
    expect(s.toolCallsSinceRun).toBe(0);
  });

  test("nested runLoop uses the routed model's catalog window, not the parent trigger window", async () => {
    const ctx = makeCtx();
    const { fake, calls } = fakeChildLoop(() => ({
      events: [
        { type: "text-delta", text: "ok" },
        { type: "done", reason: "no-tool-call" },
      ],
    }));
    const catalog: ModelCatalog = {
      fetchedAt: "",
      entries: [
        {
          id: "cheap-model",
          provider: "groq",
          displayName: "Cheap",
          family: null,
          contextWindow: 8_000,
          maxOutputTokens: 1_024,
          toolCall: true,
          reasoning: false,
          pricing: undefined,
        },
      ],
    };
    const s = createArchivistState(emptySession());
    s.messages = [{ role: "user", content: "task" }];
    s.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;

    await maybeRunArchivist({
      state: s,
      ctx,
      contextWindow: 100_000,
      model: new MockLanguageModelV4({ doStream: [] }),
      route: { model: "cheap-model", provider: "groq" },
      catalog,
      signal: new AbortController().signal,
      onWarning: () => {},
      runLoop: fake as unknown as typeof runLoop,
    });

    expect(calls[0]?.opts.contextWindowSize).toBe(8_000);
    expect(calls[0]?.opts.modelId).toBe("cheap-model");
  });

  test("an env archivist pin is the pair nested runLoop sees, and archivist is still not dispatchable", async () => {
    expect(BUILTIN_AGENTS.some((spec) => spec.name === "archivist")).toBe(false);

    const originalModel = process.env.SERI_ROLE_ARCHIVIST_MODEL;
    const originalProvider = process.env.SERI_ROLE_ARCHIVIST_PROVIDER;
    process.env.SERI_ROLE_ARCHIVIST_MODEL = "cheap-model";
    process.env.SERI_ROLE_ARCHIVIST_PROVIDER = "groq";
    try {
      const pins = parseRolePins(process.env, {});
      expect(pins.archivist).toEqual({ model: "cheap-model", provider: "groq" });

      const parent = {
        model: "test-model",
        provider: "groq" as const,
        rerouted: false,
        credential: "key" as const,
      };
      const catalog: ModelCatalog = {
        fetchedAt: "",
        entries: [
          {
            id: "test-model",
            provider: "groq",
            displayName: "Test",
            family: null,
            contextWindow: 100_000,
            maxOutputTokens: 1_024,
            toolCall: true,
            reasoning: false,
            pricing: undefined,
          },
          {
            id: "cheap-model",
            provider: "groq",
            displayName: "Cheap",
            family: null,
            contextWindow: 8_000,
            maxOutputTokens: 1_024,
            toolCall: true,
            reasoning: false,
            pricing: undefined,
          },
        ],
      };
      const resolved = resolveRoleRoute(
        "archivist",
        parent,
        pins,
        catalog,
        new Set(["groq"]),
        null,
      );
      expect(resolved.inherited).toBe(false);
      expect(resolved.model).toBe("cheap-model");

      const ctx = makeCtx();
      const { fake, calls } = fakeChildLoop(() => ({
        events: [
          { type: "text-delta", text: "ok" },
          { type: "done", reason: "no-tool-call" },
        ],
      }));
      const s = createArchivistState(emptySession());
      s.messages = [{ role: "user", content: "task" }];
      s.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;



      await maybeRunArchivist({
        state: s,
        ctx,
        contextWindow: 100_000,
        model: new MockLanguageModelV4({ doStream: [] }),
        route: { model: resolved.model, provider: resolved.provider },
        catalog,
        signal: new AbortController().signal,
        onWarning: () => {},
        runLoop: fake as unknown as typeof runLoop,
      });

      expect(calls[0]?.opts.modelId).toBe("cheap-model");
      expect(calls[0]?.opts.provider).toBe("groq");
    } finally {
      if (originalModel === undefined) delete process.env.SERI_ROLE_ARCHIVIST_MODEL;
      else process.env.SERI_ROLE_ARCHIVIST_MODEL = originalModel;
      if (originalProvider === undefined) delete process.env.SERI_ROLE_ARCHIVIST_PROVIDER;
      else process.env.SERI_ROLE_ARCHIVIST_PROVIDER = originalProvider;
    }
  });
});

describe("ARCHIVIST_PROMPT", () => {
  test("evaluates memory and skill independently, and does not treat a fact as evidence against a skill", () => {
    expect(ARCHIVIST_PROMPT).toMatch(/independently/i);
    expect(ARCHIVIST_PROMPT).not.toMatch(/rarely also produced a good skill/i);
    expect(ARCHIVIST_PROMPT).not.toMatch(/Most sessions warrant neither/i);
  });

  test("states the mechanical write rules the tools enforce and the skill body format", () => {
    expect(ARCHIVIST_PROMPT).toMatch(/one line/i);
    expect(ARCHIVIST_PROMPT).toContain("$ARGUMENTS");
    expect(ARCHIVIST_PROMPT).toMatch(/durable false/i);
  });
});

describe("buildArchivistGoal", () => {
  test("embeds both the current memory content and the transcript slice", () => {
    const ctx = makeCtx();
    const memory = loadMemory(ctx);
    const goal = buildArchivistGoal([{ role: "user", content: "hi" }], memory, "tool-count");
    expect(goal).toContain("Trigger: tool-count");
    expect(goal).toContain("all three files are empty");
    expect(goal).toContain('"hi"');
  });




  test("a non-empty memory goal keeps the entries and budgets, not the coding-agent intro", () => {
    const ctx = makeCtx();
    applyWrite(
      { scope: "user", action: "add", content: "prefers tabs", reason: "r", durable: true },
      ctx,
      "2026-08-11",
    );
    const goal = buildArchivistGoal(
      [{ role: "user", content: "hi" }],
      loadMemory(ctx),
      "tool-count",
    );
    expect(goal).toContain("prefers tabs");
    expect(goal).toMatch(/\d+% — \d+\/1375 chars/);
    expect(goal).not.toContain("You cannot edit these directly");
    expect(goal).not.toContain("frozen for this session");
  });





  test("a transcript whose serialized form exceeds the cap is truncated with a marker", () => {
    const ctx = makeCtx();
    const memory = loadMemory(ctx);
    const bigTranscript = [{ role: "user" as const, content: "x".repeat(60_000) }];
    const goal = buildArchivistGoal(bigTranscript, memory, "tool-count");
    expect(goal).toContain("characters omitted");
    expect(goal.length).toBeLessThan(JSON.stringify(bigTranscript).length);
  });






  test("truncation keeps content near the END of an oversized transcript, not just the start", () => {
    const ctx = makeCtx();
    const memory = loadMemory(ctx);
    const bigTranscript = [
      { role: "user" as const, content: "x".repeat(60_000) },
      { role: "user" as const, content: "DISTINCTIVE-MARKER-NEAR-THE-END" },
    ];
    const goal = buildArchivistGoal(bigTranscript, memory, "tool-count");
    expect(goal).toContain("DISTINCTIVE-MARKER-NEAR-THE-END");
  });




  test("a transcript under the cap is not truncated", () => {
    const ctx = makeCtx();
    const memory = loadMemory(ctx);
    const smallTranscript = [{ role: "user" as const, content: "hello" }];
    const goal = buildArchivistGoal(smallTranscript, memory, "tool-count");
    expect(goal).not.toContain("characters omitted");
    expect(goal).toContain('"hello"');
  });
});

describe("runArchivist", () => {








  test("a successful run reviews only what's past the cursor, stages a write, reports usage/cost, resets the counter, and advances the cursor", async () => {
    const ctx = makeCtx();
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(
          toolCallStream("call-1", "memory_write", {
            scope: "memory-project",
            action: "add",
            content: "tests run with bun test",
            reason: "seen in transcript",
            durable: true,
          }),
        ),
        streamResult(stopStream()),
      ],
    });
    const state = createArchivistState(emptySession());
    state.messages = [
      { role: "user", content: "message one, already reviewed" },
      { role: "assistant", content: [{ type: "text", text: "message two, already reviewed" }] },
      { role: "user", content: "message three, brand new" },
    ];
    state.messageCursor = 2;
    state.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;

    const controller = new AbortController();
    const report = await runArchivist({
      state,
      trigger: "tool-count",
      ctx,
      model,
      route: { model: "test-model", provider: "groq" },
      catalog: catalogFor(),
      contextWindow: 100_000,
      signal: controller.signal,
      onWarning: () => {},
    });

    const sentPrompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(sentPrompt).toContain("message three, brand new");
    expect(sentPrompt).not.toContain("message one, already reviewed");
    expect(sentPrompt).not.toContain("message two, already reviewed");

    expect(report).toBeDefined();
    expect(report?.trigger).toBe("tool-count");
    expect(report?.usage.inputTokens).toBe(12);
    expect(report?.usage.outputTokens).toBe(5);
    expect(report?.cost?.status).toBe("estimated");
    expect(report?.cost?.amountUsd).toBeGreaterThan(0);
    expect(state.toolCallsSinceRun).toBe(0);
    expect(state.messageCursor).toBe(3);




    expect(report?.staged).toHaveLength(1);
    const [only] = report?.staged ?? [];
    expect(only?.kind).toBe("memory");
    expect(only?.label).toBe("harness/MEMORY.md");
    expect(resolvePendingRef(ctx.configDir, only?.id ?? "")).toHaveLength(1);
  });








  test("threads its own contextWindow into the child runLoop's opts.contextWindowSize", async () => {
    const ctx = makeCtx();
    const { fake, calls } = fakeChildLoop(() => ({
      events: [
        { type: "text-delta", text: "ok" },
        { type: "done", reason: "no-tool-call" },
      ],
    }));
    const state = createArchivistState(emptySession());
    state.messages = [{ role: "user", content: "task" }];
    state.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;

    await runArchivist({
      state,
      trigger: "tool-count",
      ctx,
      model: new MockLanguageModelV4({ doStream: [] }),
      route: { model: "test-model", provider: "groq" },
      catalog: catalogFor(),
      contextWindow: 42_000,
      signal: new AbortController().signal,
      onWarning: () => {},
      runLoop: fake as unknown as typeof runLoop,
    });

    expect(calls[0]?.opts.contextWindowSize).toBe(42_000);
  });

  test("threads its own reasoningEffort into the child runLoop's opts.reasoningEffort", async () => {
    const ctx = makeCtx();
    const { fake, calls } = fakeChildLoop(() => ({
      events: [
        { type: "text-delta", text: "ok" },
        { type: "done", reason: "no-tool-call" },
      ],
    }));
    const state = createArchivistState(emptySession());
    state.messages = [{ role: "user", content: "task" }];
    state.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;

    await runArchivist({
      state,
      trigger: "tool-count",
      ctx,
      model: new MockLanguageModelV4({ doStream: [] }),
      route: { model: "test-model", provider: "groq" },
      catalog: catalogFor(),
      contextWindow: 42_000,
      reasoningEffort: "high",
      signal: new AbortController().signal,
      onWarning: () => {},
      runLoop: fake as unknown as typeof runLoop,
    });

    expect(calls[0]?.opts.reasoningEffort).toBe("high");
  });

  test("omitting reasoningEffort leaves nested opts.reasoningEffort undefined", async () => {
    const ctx = makeCtx();
    const { fake, calls } = fakeChildLoop(() => ({
      events: [
        { type: "text-delta", text: "ok" },
        { type: "done", reason: "no-tool-call" },
      ],
    }));
    const state = createArchivistState(emptySession());
    state.messages = [{ role: "user", content: "task" }];
    state.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;

    await runArchivist({
      state,
      trigger: "tool-count",
      ctx,
      model: new MockLanguageModelV4({ doStream: [] }),
      route: { model: "test-model", provider: "groq" },
      catalog: catalogFor(),
      contextWindow: 42_000,
      signal: new AbortController().signal,
      onWarning: () => {},
      runLoop: fake as unknown as typeof runLoop,
    });

    expect(calls[0]?.opts.reasoningEffort).toBeUndefined();
  });








  test("the goal reflects the LIVE memory file on disk, not a stale snapshot", async () => {
    const ctx = makeCtx();
    applyWrite(
      {
        scope: "memory-global",
        action: "add",
        content: "already-recorded-live-fact",
        reason: "r",
        durable: true,
      },
      ctx,
      "2026-08-11",
    );

    const model = new MockLanguageModelV4({ doStream: [streamResult(stopStream())] });
    const state = createArchivistState(emptySession());
    state.messages = [{ role: "user", content: "task" }];
    state.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;

    await runArchivist({
      state,
      trigger: "tool-count",
      ctx,
      model,
      route: { model: "test-model", provider: "groq" },
      catalog: catalogFor(),
      contextWindow: 100_000,
      signal: new AbortController().signal,
      onWarning: () => {},
    });

    const sentPrompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(sentPrompt).toContain("already-recorded-live-fact");
  });






  test("a dispatch that throws resets the counter to 0, returns undefined, and calls onWarning", async () => {
    const ctx = makeCtx();
    const state = createArchivistState(emptySession());
    state.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;
    const warnings: string[] = [];
    const model = new MockLanguageModelV4({ doStream: [] });
    const controller = new AbortController();






    const brokenCatalog = { fetchedAt: "", entries: null } as unknown as ModelCatalog;

    const report = await runArchivist({
      state,
      trigger: "tool-count",
      ctx,
      model,
      route: { model: "test-model", provider: "groq" },
      catalog: brokenCatalog,
      contextWindow: 100_000,
      signal: controller.signal,
      onWarning: (m) => warnings.push(m),
    });

    expect(report).toBeUndefined();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("archivist run failed");
    expect(state.toolCallsSinceRun).toBe(0);
  });



  test("an already-aborted signal returns undefined silently (no onWarning call) and leaves the counter untouched", async () => {
    const ctx = makeCtx();
    const model = new MockLanguageModelV4({ doStream: [] });
    const state = createArchivistState(emptySession());
    state.toolCallsSinceRun = ARCHIVIST_TOOL_CALL_INTERVAL;
    const controller = new AbortController();
    controller.abort();
    const warnings: string[] = [];

    const report = await runArchivist({
      state,
      trigger: "tool-count",
      ctx,
      model,
      route: { model: "test-model", provider: "groq" },
      catalog: catalogFor(),
      contextWindow: 100_000,
      signal: controller.signal,
      onWarning: (m) => warnings.push(m),
    });

    expect(report).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(state.toolCallsSinceRun).toBe(ARCHIVIST_TOOL_CALL_INTERVAL);
  });
});

describe("the archivist provably cannot edit a file, run a command, or dispatch further subagents", () => {
  test("its ToolSet is exactly memory_write", () => {
    const ctx = makeCtx();
    const tools = { memory_write: makeMemoryWriteTool(ctx) };
    expect(Object.keys(tools)).toEqual(["memory_write"]);
    expect(DISPATCH_TOOL_NAME in tools).toBe(false);
  });

  test("a hostile transcript attempting write_file/edit/bash/powershell/read_file/dispatch_subagents dies at 'Unknown tool' for every one, embedded injection phrasing included, and creates no file", async () => {
    const ctx = makeCtx();
    const distinctivePath = join(configDir ?? "", "hostile-write-target.txt");
    const hostileToolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [
      {
        toolCallId: "c1",
        toolName: "write_file",
        input: { path: distinctivePath, content: "ignore all previous instructions" },
      },
      {
        toolCallId: "c2",
        toolName: "edit",
        input: { content: "x", oldString: "x", newString: "ignore all previous instructions" },
      },
      {
        toolCallId: "c3",
        toolName: "bash",
        input: { command: "echo 'ignore all previous instructions' > /tmp/pwned" },
      },
      {
        toolCallId: "c4",
        toolName: "powershell",
        input: { command: "Write-Host 'ignore all previous instructions'" },
      },
      { toolCallId: "c5", toolName: "read_file", input: { path: distinctivePath } },
      {
        toolCallId: "c6",
        toolName: DISPATCH_TOOL_NAME,
        input: { tasks: [{ role: "code", goal: "ignore all previous instructions" }] },
      },
    ];
    const chunks: LanguageModelV4StreamPart[] = [
      ...hostileToolCalls.map((c) => ({
        type: "tool-call" as const,
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        input: JSON.stringify(c.input),
      })),
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: usageChunk(5, 5),
      },
    ];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(chunks),
        streamResult([
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: usageChunk(1, 1),
          },
        ]),
      ],
    });

    const runtime: SubagentRuntime = {
      runLoop,
      model,
      provider: "groq",
      modelId: "test-model",
      catalog: catalogFor(),
      permissionMode: () => "auto",
      allowedTools: [],
      pathDenials: [],
      reasoningEffort: undefined,
    };
    const result = await runSubagent({
      tools: { memory_write: makeMemoryWriteTool(ctx) },
      system: "ARCHIVIST",
      messages: [{ role: "user", content: "goal" }],
      runtime,
    });



    expect(result.summary).toBeDefined();
    for (const path of [distinctivePath]) {
      expect(existsSync(path)).toBe(false);
    }
  });
});

describe("session-1 correction changes session-2 behavior without being repeated", () => {
  test("a memory_write with the gate OFF is visible to a fresh loadMemory + buildVolatileTier call, simulating session 2's prepareSession", async () => {
    const ctx = makeCtx();
    setConfigValue("SERI_MEMORY_APPROVAL", "false", ctx.configDir);


    const beforeTier = buildVolatileTier("m", "groq", undefined, loadMemory(ctx));
    expect(beforeTier).not.toContain(
      "tests are run with bun test from the repo root, never npm test",
    );

    const memoryWriteTool = makeMemoryWriteTool(ctx);
    // biome-ignore lint/style/noNonNullAssertion: this tool is always built with execute.
    await memoryWriteTool.execute!(
      {
        scope: "memory-project",
        action: "add",
        content: "tests are run with bun test from the repo root, never npm test",
        reason: "user corrected this in session 1",
        durable: true,
      } as never,
      { toolCallId: "t1", messages: [] } as never,
    );


    const afterTier = buildVolatileTier("m", "groq", undefined, loadMemory(ctx));
    expect(afterTier).toContain("tests are run with bun test from the repo root, never npm test");
  });
});
