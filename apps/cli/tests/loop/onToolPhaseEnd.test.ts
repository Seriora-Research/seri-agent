// runLoop's onToolPhaseEnd hook: the seam a consumer uses to append something to the turn after a
// tool round. The loop stays ignorant of what the text is for, so everything here is about WHEN it
// is called and WHERE the result lands, never about rules.
import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { runLoop } from "../../src/loop/loop";
import {
  baseMessages,
  collect,
  makeTools,
  streamResult,
  textOnlyChunks,
  toolCallChunks,
} from "./fixtures";

function lastMessagesUpdate(events: { type: string }[]): ModelMessage[] {
  const updates = events.filter(
    (event): event is { type: "messages-updated"; messages: ModelMessage[] } =>
      event.type === "messages-updated",
  );
  return updates.at(-1)?.messages ?? [];
}

describe("onToolPhaseEnd", () => {
  test("appends the returned text as a user message after the tool row", async () => {
    const tools = makeTools(async () => "ok");
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        onToolPhaseEnd: () => "INJECTED-NOTICE",
      }),
    );

    const messages = lastMessagesUpdate(events);
    const injected = messages.filter(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("INJECTED-NOTICE"),
    );
    expect(injected).toHaveLength(1);
    // After the tool row, never before it: a user message between the assistant's tool call and its
    // tool result is an ordering providers reject.
    const toolIndex = messages.findIndex((message) => message.role === "tool");
    const injectedIndex = messages.findIndex((message) =>
      JSON.stringify(message.content).includes("INJECTED-NOTICE"),
    );
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(injectedIndex).toBeGreaterThan(toolIndex);
  });

  test("is handed the calls that actually executed, with their input", async () => {
    const seen: { toolName: string; input: unknown }[][] = [];
    const tools = makeTools(async () => "ok");
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    await collect(
      runLoop({
        model,
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        onToolPhaseEnd: (executed) => {
          seen.push([...executed]);
          return undefined;
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([{ toolName: "write_file", input: { path: "a.txt" } }]);
  });

  test("returning undefined appends nothing", async () => {
    const tools = makeTools(async () => "ok");
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        onToolPhaseEnd: () => undefined,
      }),
    );
    const users = lastMessagesUpdate(events).filter((message) => message.role === "user");
    // Only the original user turn from baseMessages.
    expect(users).toHaveLength(1);
  });

  // The control that guards the ordered-tier decision. The whole point of injecting into the turn
  // rather than the system prompt is that `system` never moves; if it ever did, the provider's
  // prefix cache would diverge in front of the entire conversation.
  test("never touches the system string", async () => {
    const systems: (string | undefined)[] = [];
    const tools = makeTools(async () => "ok");
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const SYSTEM = "STABLE-SYSTEM-STRING";
    await collect(
      runLoop({
        model,
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        system: SYSTEM,
        onToolPhaseEnd: () => "INJECTED-NOTICE",
      }),
    );
    // Both model calls in the turn were issued with the identical system string.
    const calls = model.doStreamCalls;
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      const system = call.prompt.find((message) => message.role === "system");
      systems.push(system === undefined ? undefined : JSON.stringify(system.content));
    }
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toContain(SYSTEM);
  });

  test("a blocked tool call executes nothing, so the hook is never called", async () => {
    const tools = makeTools(async () => "ok");
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    let calls = 0;
    await collect(
      runLoop({
        model,
        tools,
        messages: baseMessages,
        // read-only blocks write_file at the gate, so nothing reaches execute.
        permissionMode: "read-only",
        onToolPhaseEnd: () => {
          calls++;
          return "INJECTED-NOTICE";
        },
      }),
    );
    expect(calls).toBe(0);
  });

  test("a thrown tool is not reported as executed", async () => {
    const seen: { toolName: string; input: unknown }[][] = [];
    const tools = makeTools(async () => {
      throw new Error("boom");
    });
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "a.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    await collect(
      runLoop({
        model,
        tools,
        messages: baseMessages,
        permissionMode: "auto",
        onToolPhaseEnd: (executed) => {
          seen.push([...executed]);
          return undefined;
        },
      }),
    );
    // The hook is skipped entirely for a round in which nothing executed.
    expect(seen).toEqual([]);
  });
});
