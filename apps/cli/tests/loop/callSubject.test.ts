




import { describe, expect, test } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { type ModelMessage, type ToolSet, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { type LoopEvent, runLoop } from "../../src/loop/loop";
import { MCP_TOOL_NAME, mcpCallSubject } from "../../src/mcp/tool";
import {
  baseMessages,
  collect,
  makeTools,
  streamResult,
  textOnlyChunks,
  toolCallChunks,
  usage,
} from "./fixtures";

const REMAP = (toolName: string) => (toolName === "write_file" ? "remapped_subject" : toolName);

function twoTurnModel() {
  return new MockLanguageModelV4({
    doStream: [
      streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
      streamResult(textOnlyChunks("Done")),
    ],
  });
}

function twoToolCallChunks(): LanguageModelV4StreamPart[] {
  return [
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "write_file",
      input: JSON.stringify({ path: "a.txt" }),
    },
    {
      type: "tool-call",
      toolCallId: "call-2",
      toolName: "write_file",
      input: JSON.stringify({ path: "b.txt" }),
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(5, 5) },
  ];
}

function lastToolRow(events: readonly LoopEvent[]): { toolName: string }[] {
  const update = events
    .filter(
      (e): e is Extract<LoopEvent, { type: "messages-updated" }> => e.type === "messages-updated",
    )
    .at(-1);
  const toolMessage = update?.messages.at(-1) as ModelMessage & { content: { toolName: string }[] };
  return toolMessage.content;
}

describe("callSubject", () => {
  test("a remapped name, not the ToolSet key, is what reaches the gate", async () => {
    const tools = makeTools(async () => "ok");


    const stillAsked = await collect(
      runLoop({
        model: twoTurnModel(),
        tools,
        messages: baseMessages,
        permissionMode: "approve-each",
        callSubject: REMAP,
        allowedTools: ["write_file"],
        approvalPrompt: async () => "no",
      }),
    );
    expect(stillAsked.find((e) => e.type === "permission-denied")).toBeTruthy();


    const events = await collect(
      runLoop({
        model: twoTurnModel(),
        tools,
        messages: baseMessages,
        permissionMode: "approve-each",
        callSubject: REMAP,
        allowedTools: ["remapped_subject"],
        approvalPrompt: async () => {
          throw new Error("must not be called: remapped_subject was already seeded as allowed");
        },
      }),
    );
    expect(events.find((e) => e.type === "tool-result")).toBeTruthy();
  });

  test("the remapped name appears in tool-call, tool-result, tool-allowed and permission-denied events", async () => {
    const events = await collect(
      runLoop({
        model: twoTurnModel(),
        tools: makeTools(async () => "ok"),
        messages: baseMessages,
        permissionMode: "approve-each",
        callSubject: REMAP,
        approvalPrompt: async () => "always",
      }),
    );

    expect(events).toContainEqual({ type: "tool-allowed", name: "remapped_subject" });
    expect(events).toContainEqual({
      type: "tool-call",
      name: "remapped_subject",
      args: { path: "a.txt" },
    });
    expect(events).toContainEqual({
      type: "tool-result",
      name: "remapped_subject",
      result: "ok",
    });
    const denied = await collect(
      runLoop({
        model: twoTurnModel(),
        tools: makeTools(async () => "ok"),
        messages: baseMessages,
        permissionMode: "approve-each",
        callSubject: REMAP,
        approvalPrompt: async () => "no",
      }),
    );
    expect(denied).toContainEqual({
      type: "permission-denied",
      name: "remapped_subject",
      reason: "declined",
    });
  });



  test("the ModelMessage tool-result row still carries the ToolSet key, not the subject", async () => {
    const events = await collect(
      runLoop({
        model: twoTurnModel(),
        tools: makeTools(async () => "ok"),
        messages: baseMessages,
        permissionMode: "auto",
        callSubject: REMAP,
      }),
    );

    const toolRowUpdate = events.find(
      (e): e is Extract<typeof e, { type: "messages-updated" }> =>
        e.type === "messages-updated" && e.messages.at(-1)?.role === "tool",
    );
    const toolMessage = toolRowUpdate?.messages.at(-1) as ModelMessage & {
      content: { toolName: string }[];
    };
    expect(toolMessage.content[0]?.toolName).toBe("write_file");
  });

  test("a thrown execute names the remapped subject in its error, and the wire row still carries the key", async () => {
    const model = new MockLanguageModelV4({
      doStream: [streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" }))],
    });
    const tools = makeTools(async () => {
      throw new Error("disk full");
    });

    const events = await collect(
      runLoop({ model, tools, messages: baseMessages, permissionMode: "auto", callSubject: REMAP }),
    );

    const errorEvent = events.find(
      (e): e is Extract<LoopEvent, { type: "error" }> => e.type === "error",
    );
    expect(errorEvent?.error).toContain('Tool "remapped_subject" threw during execution');
    expect(errorEvent?.error).not.toContain('Tool "write_file" threw');
    expect(lastToolRow(events)[0]?.toolName).toBe("write_file");
  });

  test("an unanswered call's cancellation reason names the remapped subject, with the row still carrying the key", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: async () => streamResult(twoToolCallChunks()),
    });

    const events: LoopEvent[] = [];
    for await (const event of runLoop({
      model,
      tools: makeTools(async () => "ok"),
      messages: baseMessages,
      permissionMode: "auto",
      callSubject: REMAP,
      signal: controller.signal,
    })) {
      events.push(event);

      if (event.type === "messages-updated") controller.abort();
    }

    const row = lastToolRow(events) as unknown as {
      toolName: string;
      output: { reason: string };
    }[];
    expect(row).toHaveLength(2);
    for (const part of row) {
      expect(part.output.reason).toBe(
        'Tool "remapped_subject" was cancelled by the user before it completed.',
      );
      expect(part.toolName).toBe("write_file");
    }
  });
});




describe("mcpCallSubject as runLoop's callSubject", () => {
  function mcpOnlyTools(): ToolSet {
    return {
      [MCP_TOOL_NAME]: tool({
        description: "mcp",
        inputSchema: z.object({
          tool: z.string(),
          arguments: z.record(z.string(), z.unknown()).optional(),
        }),
        execute: async () => "must not run: this call should be blocked before execute",
      }),
    };
  }

  test("read-only blocks an mcp call whose input names a built-in read tool", async () => {



    const model = new MockLanguageModelV4({
      doStream: [streamResult(toolCallChunks("call-1", MCP_TOOL_NAME, { tool: "read_file" }))],
    });

    const events = await collect(
      runLoop({
        model,
        tools: mcpOnlyTools(),
        messages: baseMessages,
        permissionMode: "read-only",
        callSubject: mcpCallSubject,
      }),
    );

    expect(events).toContainEqual({
      type: "permission-denied",
      name: MCP_TOOL_NAME,
      reason: "blocked",
    });
    expect(events.find((e) => e.type === "tool-result")).toBeUndefined();
  });
});
