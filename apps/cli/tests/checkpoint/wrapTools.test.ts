import { describe, expect, test } from "bun:test";
import { tool, type ModelMessage, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { withCheckpoints, type MutationContext } from "../../src/checkpoint/wrapTools";

const messages: ModelMessage[] = [
  { role: "user", content: "do the task" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "write_file", input: {} }] },
];

function execOpts(toolCallId = "c1"): ToolExecutionOptions<Record<string, unknown>> {
  return { toolCallId, messages, context: {} };
}

function fakeTools(execute: (args: { path: string }) => unknown): ToolSet {
  const definition = tool({
    description: "fake",
    inputSchema: z.object({ path: z.string() }),
    execute: async (args) => execute(args),
  });
  return {
    write_file: definition,
    bash: definition,
    powershell: definition,
    read_file: definition,
    edit: definition,
    grep: definition,
    glob: definition,
  };
}

describe("withCheckpoints", () => {
  test("runs the callback before the tool, not after", async () => {
    const order: string[] = [];
    const wrapped = withCheckpoints(
      fakeTools(() => {
        order.push("execute");
        return "ok";
      }),
      () => order.push("snapshot"),
    );

    await wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts());

    expect(order).toEqual(["snapshot", "execute"]);
  });

  test("returns non-mutating tools by reference and never checkpoints them", async () => {
    const calls: MutationContext[] = [];
    const tools = fakeTools(() => "ok");
    const wrapped = withCheckpoints(tools, (context) => calls.push(context));

    for (const name of ["read_file", "edit", "grep", "glob"]) {
      expect(wrapped[name]).toBe(tools[name]);
      await wrapped[name]?.execute?.({ path: "a.txt" }, execOpts());
    }

    expect(calls).toEqual([]);
  });

  test("checkpoints every filesystem-mutating tool", async () => {
    const calls: MutationContext[] = [];
    const wrapped = withCheckpoints(fakeTools(() => "ok"), (context) => calls.push(context));

    for (const name of ["write_file", "bash", "powershell"]) {
      await wrapped[name]?.execute?.({ path: "a.txt" }, execOpts());
    }

    expect(calls.map((call) => call.tool)).toEqual(["write_file", "bash", "powershell"]);
  });

  test("passes the tool's result through unchanged", async () => {
    const wrapped = withCheckpoints(fakeTools(() => ({ written: 3 })), () => {});

    expect(await wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts())).toEqual({ written: 3 });
  });

  test("re-throws the tool's error unchanged", async () => {
    const wrapped = withCheckpoints(
      fakeTools(() => {
        throw new Error("disk full");
      }),
      () => {},
    );

    expect(wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts())).rejects.toThrow("disk full");
  });

  test("hands the callback the toolCallId, the args, and messages.length - 1 as the rewind anchor", async () => {
    const calls: MutationContext[] = [];
    const wrapped = withCheckpoints(fakeTools(() => "ok"), (context) => calls.push(context));

    await wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts("call-42"));

    expect(calls).toEqual([
      { tool: "write_file", toolCallId: "call-42", args: { path: "a.txt" }, rewindTo: messages.length - 1 },
    ]);
  });
});
