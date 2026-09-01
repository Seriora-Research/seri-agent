// Consumer probes for consecutive read-only execute overlap: replay the actual
// runLoop event stream through the TUI reducer (parent and child slots), and
// pin onToolPhaseEnd seeing every read that ran.
import { describe, expect, test } from "bun:test";
import type { ModelMessage, ToolSet } from "ai";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { type LoopEvent, runLoop } from "../../src/loop/loop";
import type { SessionState } from "../../src/session/session";
import type { ChildEventPayload } from "../../src/subagents/dispatch";
import { initialTuiState, tuiReducer } from "../../src/tui/state/reducer";
import { renderToolActivity } from "../../src/tui/state/toolActivity";
import {
  baseMessages,
  collect,
  multiToolCallChunks,
  streamResult,
  textOnlyChunks,
} from "./fixtures";

function session(): SessionState<ModelMessage> {
  return {
    id: "s1",
    cwd: "/repo",
    systemPrompt: "",
    permissionMode: "auto",
    messages: [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayedReads(): ToolSet {
  const delay = async (name: string) => {
    await sleep(40);
    return `${name}-ok`;
  };
  return {
    read_file: tool({
      description: "read",
      inputSchema: z.object({ path: z.string() }),
      execute: async () => delay("read_file"),
    }),
    grep: tool({
      description: "grep",
      inputSchema: z.object({ pattern: z.string(), path: z.string() }),
      execute: async () => delay("grep"),
    }),
    glob: tool({
      description: "glob",
      inputSchema: z.object({ pattern: z.string(), path: z.string() }),
      execute: async () => delay("glob"),
    }),
  };
}

function threeReads() {
  return multiToolCallChunks([
    { toolCallId: "call-1", toolName: "read_file", input: { path: "a.txt" } },
    { toolCallId: "call-2", toolName: "grep", input: { pattern: "x", path: "." } },
    { toolCallId: "call-3", toolName: "glob", input: { pattern: "*.ts", path: "." } },
  ]);
}

function replay(events: LoopEvent[]) {
  let state = initialTuiState(session());
  for (const event of events) {
    state = tuiReducer(state, { type: "loop-event", event });
  }
  return state;
}

function childAction(event: ChildEventPayload["event"]) {
  return {
    type: "subagent-child-event" as const,
    childId: "t1:0",
    role: "explore",
    goal: "find a",
    event,
  };
}

function forwarded(event: LoopEvent): boolean {
  return event.type !== "messages-updated" && event.type !== "retry" && event.type !== "tool-allowed";
}

describe("parallel read-only blast radius", () => {
  test("replaying a three-read step through the TUI reducer does not record a throw", async () => {
    const model = new MockLanguageModelV4({
      doStream: [streamResult(threeReads()), streamResult(textOnlyChunks("Done"))],
    });
    const events = await collect(
      runLoop({
        model,
        tools: delayedReads(),
        messages: baseMessages,
        permissionMode: "auto",
      }),
    );
    const state = replay(events);
    const painted = state.transcript.filter((e) => e.muted).map((e) => e.text);
    expect(painted.some((text) => text.includes("failed") || text.includes("error"))).toBe(false);
    expect(state.pendingTool).toBeUndefined();
  });

  test("a PreToolUse error on a later read is not painted as the in-flight read throwing", async () => {
    const model = new MockLanguageModelV4({
      doStream: [streamResult(threeReads()), streamResult(textOnlyChunks("Done"))],
    });
    const events = await collect(
      runLoop({
        model,
        tools: delayedReads(),
        messages: baseMessages,
        permissionMode: "auto",
        onBeforeTool: async (subject) =>
          subject === "grep" ? { errors: ["lint could not be run"] } : {},
      }),
    );
    expect(events).toContainEqual({ type: "error", error: "lint could not be run" });

    let state = initialTuiState(session());
    let smashed = false;
    for (const event of events) {
      state = tuiReducer(state, { type: "loop-event", event });
      if (event.type === "error") {
        const painted = renderToolActivity(state.toolActivity).join("\n");
        if (painted.includes("lint could not be run") && painted.includes("Read")) smashed = true;
        expect(state.pendingTool).toBeUndefined();
      }
    }
    expect(smashed).toBe(false);
    expect(events.filter((e) => e.type === "tool-result")).toHaveLength(3);
  });

  test("the same PreToolUse error is not a false throw on a child currentTool slot", async () => {
    const model = new MockLanguageModelV4({
      doStream: [streamResult(threeReads()), streamResult(textOnlyChunks("Done"))],
    });
    const events = await collect(
      runLoop({
        model,
        tools: delayedReads(),
        messages: baseMessages,
        permissionMode: "auto",
        onBeforeTool: async (subject) =>
          subject === "grep" ? { errors: ["lint could not be run"] } : {},
      }),
    );

    let state = initialTuiState(session());
    state = tuiReducer(state, childAction({ type: "child-started" }));
    let smashed = false;
    for (const event of events) {
      if (!forwarded(event)) continue;
      state = tuiReducer(state, childAction(event));
      if (event.type === "error") {
        const child = state.subagents[0];
        const painted = renderToolActivity(child?.toolActivity ?? []).join("\n");
        if (painted.includes("lint could not be run") && painted.includes("Read")) smashed = true;
        expect(child?.currentTool).toBeUndefined();
      }
    }
    expect(smashed).toBe(false);
  });

  test("PostToolUse for parallel reads runs in original order after sibling executes have started", async () => {
    const after: string[] = [];
    let grepStarted = false;
    let readAfterBeforeGrepStart = false;
    const tools: ToolSet = {
      read_file: tool({
        description: "read",
        inputSchema: z.object({ path: z.string() }),
        execute: async () => {
          await sleep(40);
          return "read_file-ok";
        },
      }),
      grep: tool({
        description: "grep",
        inputSchema: z.object({ pattern: z.string(), path: z.string() }),
        execute: async () => {
          grepStarted = true;
          await sleep(40);
          return "grep-ok";
        },
      }),
      glob: tool({
        description: "glob",
        inputSchema: z.object({ pattern: z.string(), path: z.string() }),
        execute: async () => {
          await sleep(40);
          return "glob-ok";
        },
      }),
    };
    const model = new MockLanguageModelV4({
      doStream: [streamResult(threeReads()), streamResult(textOnlyChunks("Done"))],
    });
    await collect(
      runLoop({
        model,
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        onAfterTool: async (subject) => {
          if (subject === "read_file" && !grepStarted) readAfterBeforeGrepStart = true;
          after.push(subject);
          return [];
        },
      }),
    );
    expect(after).toEqual(["read_file", "grep", "glob"]);
    // Execute overlap starts every read before any PostToolUse. Serial runLoop ran
    // each PostToolUse before the next execute; that order is not the contract here.
    expect(readAfterBeforeGrepStart).toBe(false);
  });

  test("onToolPhaseEnd is handed every read that executed", async () => {
    const seen: { toolName: string; input: unknown }[][] = [];
    const model = new MockLanguageModelV4({
      doStream: [streamResult(threeReads()), streamResult(textOnlyChunks("Done"))],
    });
    await collect(
      runLoop({
        model,
        tools: delayedReads(),
        messages: baseMessages,
        permissionMode: "auto",
        onToolPhaseEnd: (executed) => {
          seen.push([...executed]);
          return undefined;
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.map((row) => row.toolName)).toEqual(["read_file", "grep", "glob"]);
  });
});
