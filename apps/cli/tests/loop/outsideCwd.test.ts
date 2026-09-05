import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { tool, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { type ApprovalAnswer, runLoop } from "../../src/loop/loop";
import type { Consent } from "../../src/gate/fsBoundary";
import {
  baseMessages,
  collect,
  makeTools,
  multiToolCallChunks,
  streamResult,
  textOnlyChunks,
  toolCallChunks,
} from "./fixtures";

const cwd = resolve("/tmp/seri-outside-cwd-loop");

function makeReadTools(execute: (input: { path: string }) => Promise<string>): ToolSet {
  return {
    read_file: tool({
      description: "read a file",
      inputSchema: z.object({ path: z.string() }),
      execute,
    }),
  };
}

describe("runLoop outside-cwd FS policy", () => {
  test("omitting workingDirectory keeps the name-only gate: an outside read does not prompt", async () => {
    const asked: string[] = [];
    const executed: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "read_file", { path: "/etc/passwd" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: makeReadTools(async (input) => {
          executed.push(input.path);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        approvalPrompt: async (name) => {
          asked.push(name);
          return "no";
        },
        askOutsideFs: true,
      }),
    );
    expect(asked).toEqual([]);
    expect(executed).toEqual(["/etc/passwd"]);
    expect(events.find((e) => e.type === "permission-denied")).toBeUndefined();
  });

  test("an inside relative read does not prompt", async () => {
    const asked: string[] = [];
    const executed: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "read_file", { path: "note.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    await collect(
      runLoop({
        model,
        tools: makeReadTools(async (input) => {
          executed.push(input.path);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        workingDirectory: cwd,
        askOutsideFs: true,
        approvalPrompt: async (name) => {
          asked.push(name);
          return "no";
        },
      }),
    );
    expect(asked).toEqual([]);
    expect(executed).toEqual(["note.txt"]);
  });

  test("the first outside read prompts once; a second call in the same turn does not", async () => {
    const asked: unknown[] = [];
    const executed: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(
          multiToolCallChunks([
            { toolCallId: "call-1", toolName: "read_file", input: { path: "/etc/passwd" } },
            { toolCallId: "call-2", toolName: "read_file", input: { path: "/etc/hosts" } },
          ]),
        ),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: makeReadTools(async (input) => {
          executed.push(input.path);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "auto",
        workingDirectory: cwd,
        askOutsideFs: true,
        approvalPrompt: async (name, args) => {
          asked.push({ name, args });
          return "once";
        },
      }),
    );
    expect(asked).toEqual([{ name: "read_file", args: { path: "/etc/passwd" } }]);
    expect(executed).toEqual(["/etc/passwd", "/etc/hosts"]);
    expect(events.find((e) => e.type === "tool-allowed")).toBeUndefined();
  });

  test("always on an outside read is once for the folder and does not emit tool-allowed", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "read_file", { path: "/etc/passwd" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: makeReadTools(async () => "ok"),
        messages: baseMessages,
        permissionMode: "auto",
        workingDirectory: cwd,
        askOutsideFs: true,
        approvalPrompt: async () => "always",
      }),
    );
    expect(events.find((e) => e.type === "tool-allowed")).toBeUndefined();
    expect(events.find((e) => e.type === "tool-call")).toBeTruthy();
  });

  test("no on the first outside read blocks a second without prompting again", async () => {
    const asked: number[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "read_file", { path: "/etc/passwd" })),
        streamResult(toolCallChunks("call-2", "read_file", { path: "/etc/hosts" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: makeReadTools(async () => "ok"),
        messages: baseMessages,
        permissionMode: "auto",
        workingDirectory: cwd,
        askOutsideFs: true,
        approvalPrompt: async () => {
          asked.push(1);
          return "no";
        },
      }),
    );
    expect(asked).toHaveLength(1);
    const denied = events.filter((e) => e.type === "permission-denied");
    expect(denied).toEqual([
      { type: "permission-denied", name: "read_file", reason: "declined" },
      { type: "permission-denied", name: "read_file", reason: "blocked" },
    ]);
    expect(events.find((e) => e.type === "tool-call")).toBeUndefined();
  });

  test("standing deny blocks without calling the prompt", async () => {
    let prompted = false;
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "read_file", { path: "/etc/passwd" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: makeReadTools(async () => "ok"),
        messages: baseMessages,
        permissionMode: "auto",
        workingDirectory: cwd,
        askOutsideFs: true,
        blockReadsOutsideWorkingDirectories: true,
        approvalPrompt: async () => {
          prompted = true;
          return "once";
        },
      }),
    );
    expect(prompted).toBe(false);
    expect(events).toContainEqual({
      type: "permission-denied",
      name: "read_file",
      reason: "blocked",
    });
  });

  test("a dummy prompt function is not a live human: askOutsideFs false blocks without declining", async () => {
    let prompted = false;
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "read_file", { path: "/etc/passwd" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: makeReadTools(async () => "ok"),
        messages: baseMessages,
        permissionMode: "auto",
        workingDirectory: cwd,
        askOutsideFs: false,
        approvalPrompt: async () => {
          prompted = true;
          return "no";
        },
      }),
    );
    expect(prompted).toBe(false);
    expect(events).toContainEqual({
      type: "permission-denied",
      name: "read_file",
      reason: "blocked",
    });
    expect(events.at(-1)).toEqual({ type: "done", reason: "no-tool-call" });
  });

  test("the outside-cwd deny text names the working directory, not the permission mode", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "read_file", { path: "/etc/passwd" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: makeReadTools(async () => "ok"),
        messages: baseMessages,
        permissionMode: "auto",
        workingDirectory: cwd,
        askOutsideFs: false,
      }),
    );
    const toolMessage = events
      .filter((e) => e.type === "messages-updated")
      .map((e) => (e.type === "messages-updated" ? e.messages.at(-1) : undefined))
      .find((message) => message?.role === "tool");
    const output = (toolMessage?.content as { output: { reason: string } }[] | undefined)?.[0]
      ?.output;
    expect(output?.reason).toContain("outside the working directory");
    expect(output?.reason).not.toContain("permission mode:");
  });

  test("a shared consent box carries a yes across two runLoop calls", async () => {
    const asked: number[] = [];
    const consent = { current: "unasked" as Consent };
    async function oneTurn(path: string, answer: ApprovalAnswer) {
      const model = new MockLanguageModelV4({
        doStream: [
          streamResult(toolCallChunks("call-1", "read_file", { path })),
          streamResult(textOnlyChunks("Done")),
        ],
      });
      return collect(
        runLoop({
          model,
          tools: makeReadTools(async () => "ok"),
          messages: baseMessages,
          permissionMode: "auto",
          workingDirectory: cwd,
          askOutsideFs: true,
          outsideConsent: consent,
          approvalPrompt: async () => {
            asked.push(1);
            return answer;
          },
        }),
      );
    }
    await oneTurn("/etc/passwd", "once");
    const second = await oneTurn("/etc/hosts", "no");
    expect(asked).toHaveLength(1);
    expect(second.find((e) => e.type === "permission-denied")).toBeUndefined();
    expect(consent.current).toBe("allowed-this-run");
  });

  test("a persisted write_file grant still asks once for an outside path", async () => {
    const asked: unknown[] = [];
    const executed: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "/tmp/out.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    await collect(
      runLoop({
        model,
        tools: makeTools(async (input) => {
          executed.push(input.path);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "approve-each",
        allowedTools: ["write_file"],
        workingDirectory: cwd,
        askOutsideFs: true,
        approvalPrompt: async (name, args) => {
          asked.push({ name, args });
          return "once";
        },
      }),
    );
    expect(asked).toEqual([{ name: "write_file", args: { path: "/tmp/out.txt" } }]);
    expect(executed).toEqual(["/tmp/out.txt"]);
  });

  test("an unpersisted write_file outside asks once, not once for the folder and again for the tool", async () => {
    const asked: unknown[] = [];
    const executed: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "/tmp/out.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    await collect(
      runLoop({
        model,
        tools: makeTools(async (input) => {
          executed.push(input.path);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "approve-each",
        workingDirectory: cwd,
        askOutsideFs: true,
        approvalPrompt: async (name, args) => {
          asked.push({ name, args });
          return "once";
        },
      }),
    );
    expect(asked).toEqual([{ name: "write_file", args: { path: "/tmp/out.txt" } }]);
    expect(executed).toEqual(["/tmp/out.txt"]);
  });

  test("always on an outside write grants nothing beyond this run: no tool-allowed, and the next inside write still asks", async () => {
    const asked: unknown[] = [];
    const executed: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        streamResult(toolCallChunks("call-1", "write_file", { path: "/tmp/out.txt" })),
        streamResult(toolCallChunks("call-2", "write_file", { path: "inside.txt" })),
        streamResult(textOnlyChunks("Done")),
      ],
    });
    const events = await collect(
      runLoop({
        model,
        tools: makeTools(async (input) => {
          executed.push(input.path);
          return "ok";
        }),
        messages: baseMessages,
        permissionMode: "approve-each",
        workingDirectory: cwd,
        askOutsideFs: true,
        approvalPrompt: async (name, args) => {
          asked.push({ name, args });
          return "always";
        },
      }),
    );
    expect(asked).toEqual([
      { name: "write_file", args: { path: "/tmp/out.txt" } },
      { name: "write_file", args: { path: "inside.txt" } },
    ]);
    expect(executed).toEqual(["/tmp/out.txt", "inside.txt"]);
    expect(events.filter((e) => e.type === "tool-allowed")).toEqual([
      { type: "tool-allowed", name: "write_file" },
    ]);
  });
});
