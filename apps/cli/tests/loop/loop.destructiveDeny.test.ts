import { describe, expect, test } from "bun:test";
import { type ToolSet, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import type { ToolCallClassifier } from "../../src/gate/classifier";
import { runLoop } from "../../src/loop/loop";
import {
  baseMessages,
  collect,
  multiToolCallChunks,
  streamResult,
  textOnlyChunks,
  toolCallChunks,
} from "./fixtures";

function shellTools(execute: (tool: string, command: string) => Promise<string>): ToolSet {
  return {
    bash: tool({
      description: "run bash",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => execute("bash", command),
    }),
    powershell: tool({
      description: "run powershell",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => execute("powershell", command),
    }),
  };
}

function protectRemoveItem(pathNeedle: string): ToolCallClassifier {
  return (_name, args) => {
    const command =
      args !== null && typeof args === "object" && "command" in args
        ? String((args as { command: unknown }).command)
        : "";
    if (/\bRemove-Item\b/i.test(command) && command.includes(pathNeedle)) {
      return { kind: "block", reason: "This path is protected from removal." };
    }
    return { kind: "allow" };
  };
}

describe("runLoop destructive deny", () => {
  const tree = "E:\\SS";

  test("after a protected-path Remove-Item deny, a follow-up cmd rmdir is not executed and the turn stops", async () => {
    const executed: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(
          toolCallChunks("call-1", "powershell", {
            command: `Remove-Item "${tree}" -Recurse -Force`,
          }),
        ),
        streamResult(
          toolCallChunks("call-2", "bash", {
            command: `cmd /c rmdir /s /q "${tree}"`,
          }),
        ),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: shellTools(async (toolName, command) => {
          executed.push(`${toolName}:${command}`);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: "/tmp/project",
        classifyToolCall: protectRemoveItem(tree),
      }),
    );

    expect(executed).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(events).toContainEqual({
      type: "permission-denied",
      name: "powershell",
      reason: "blocked",
    });
    expect(events.at(-1)).toEqual({ type: "done", reason: "destructive-denied" });
    expect(events.filter((event) => event.type === "tool-result")).toEqual([]);
  });

  test("a same-batch rmdir on the denied tree is also denied", async () => {
    const executed: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(
          multiToolCallChunks([
            {
              toolCallId: "call-1",
              toolName: "powershell",
              input: { command: `Remove-Item "${tree}" -Recurse -Force` },
            },
            {
              toolCallId: "call-2",
              toolName: "bash",
              input: { command: `cmd /c rmdir /s /q "${tree}"` },
            },
          ]),
        ),
        streamResult(textOnlyChunks("should not run")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: shellTools(async (toolName, command) => {
          executed.push(`${toolName}:${command}`);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: "/tmp/project",
        classifyToolCall: protectRemoveItem(tree),
      }),
    );

    expect(executed).toEqual([]);
    expect(events.filter((event) => event.type === "permission-denied")).toEqual([
      { type: "permission-denied", name: "powershell", reason: "blocked" },
      { type: "permission-denied", name: "bash", reason: "blocked" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "destructive-denied" });
  });

  test("a quoting mishap that would delete the parent is denied after a subfolder deny", async () => {
    const executed: string[] = [];
    const sub = "C:\\t\\parent\\sub";
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(
          multiToolCallChunks([
            {
              toolCallId: "call-1",
              toolName: "powershell",
              input: { command: `Remove-Item "${sub}" -Recurse -Force` },
            },
            {
              toolCallId: "call-2",
              toolName: "bash",
              input: { command: 'cmd /c "rmdir /s /q \\"C:\\t\\parent\\sub\\""' },
            },
          ]),
        ),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: shellTools(async (_tool, command) => {
          executed.push(command);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: "/tmp/project",
        classifyToolCall: protectRemoveItem(sub),
      }),
    );

    expect(executed).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "destructive-denied" });
  });

  test("a write_file path deny covers powershell Remove-Item on that tree", async () => {
    const executed: string[] = [];
    const protectedTree = "/tmp/protected/tree";
    const events = await collect(
      runLoop({
        model: new MockLanguageModelV4({
          doStream: [
            streamResult(
              toolCallChunks("call-1", "powershell", {
                command: `Remove-Item "${protectedTree}" -Recurse -Force`,
              }),
            ),
            streamResult(textOnlyChunks("Done")),
          ],
        }),
        tools: shellTools(async (toolName, command) => {
          executed.push(`${toolName}:${command}`);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: "/tmp/project",
        pathDenials: [{ tool: "write_file", pattern: `${protectedTree}/**` }],
      }),
    );

    expect(executed).toEqual([]);
    expect(events).toContainEqual({
      type: "permission-denied",
      name: "powershell",
      reason: "blocked",
    });
    expect(events.at(-1)).toEqual({ type: "done", reason: "destructive-denied" });
  });

  test("a same-batch echo after a denied Remove-Item still executes", async () => {
    const executed: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(
          multiToolCallChunks([
            {
              toolCallId: "call-1",
              toolName: "powershell",
              input: { command: `Remove-Item "${tree}" -Recurse -Force` },
            },
            {
              toolCallId: "call-2",
              toolName: "bash",
              input: { command: "echo hi" },
            },
          ]),
        ),
        streamResult(textOnlyChunks("should not run")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: shellTools(async (_tool, command) => {
          executed.push(command);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: "/tmp/project",
        classifyToolCall: protectRemoveItem(tree),
      }),
    );
    expect(executed).toEqual(["echo hi"]);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", reason: "destructive-denied" });
  });

  test("a non-destructive bash call still runs when nothing was denied", async () => {
    const executed: string[] = [];
    await collect(
      runLoop({
        model: new MockLanguageModelV4({
          doStream: [
            streamResult(toolCallChunks("call-1", "bash", { command: "echo hi" })),
            streamResult(textOnlyChunks("Done")),
          ],
        }),
        tools: shellTools(async (_tool, command) => {
          executed.push(command);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: "/tmp/project",
        classifyToolCall: protectRemoveItem(tree),
      }),
    );
    expect(executed).toEqual(["echo hi"]);
  });

  test("a classifier deny of git push still continues the turn", async () => {
    const executed: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "bash", { command: "git push origin v0.42.0" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: shellTools(async (_tool, command) => {
          executed.push(command);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: "/tmp/project",
        classifyToolCall: (_name, args) => {
          const command =
            args !== null && typeof args === "object" && "command" in args
              ? String((args as { command: unknown }).command)
              : "";
          if (command.includes("git push")) {
            return { kind: "block", reason: "tag push publishes the package" };
          }
          return { kind: "allow" };
        },
      }),
    );
    expect(executed).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("autoModeOnBlock ask prompts on a protected Remove-Item instead of a silent tool error", async () => {
    const executed: string[] = [];
    let prompted = 0;
    const events = await collect(
      runLoop({
        model: new MockLanguageModelV4({
          doStream: [
            streamResult(
              toolCallChunks("call-1", "powershell", {
                command: `Remove-Item "${tree}" -Recurse -Force`,
              }),
            ),
            streamResult(textOnlyChunks("Done")),
          ],
        }),
        tools: shellTools(async (_tool, command) => {
          executed.push(command);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: "/tmp/project",
        classifyToolCall: protectRemoveItem(tree),
        autoModeOnBlock: "ask",
        approvalPrompt: async () => {
          prompted += 1;
          return "once";
        },
      }),
    );
    expect(prompted).toBe(1);
    expect(executed).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("declining a protected Remove-Item at the ask prompt still stops the turn", async () => {
    const executed: string[] = [];
    const events = await collect(
      runLoop({
        model: new MockLanguageModelV4({
          doStream: [
            streamResult(
              toolCallChunks("call-1", "powershell", {
                command: `Remove-Item "${tree}" -Recurse -Force`,
              }),
            ),
            streamResult(
              toolCallChunks("call-2", "bash", { command: `cmd /c rmdir /s /q "${tree}"` }),
            ),
          ],
        }),
        tools: shellTools(async (_tool, command) => {
          executed.push(command);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        cwd: "/tmp/project",
        classifyToolCall: protectRemoveItem(tree),
        autoModeOnBlock: "ask",
        approvalPrompt: async () => "no",
      }),
    );
    expect(executed).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "destructive-denied" });
  });
});
