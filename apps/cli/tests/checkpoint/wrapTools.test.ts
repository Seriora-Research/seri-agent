import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelMessage, type ToolExecutionOptions, type ToolSet, tool } from "ai";
import { z } from "zod";
import { initShadow, isGitAvailable, writeTree } from "../../src/checkpoint/shadowGit";
import {
  type MutationContext,
  withCheckpoints,
  withMutationRecording,
} from "../../src/checkpoint/wrapTools";

const messages: ModelMessage[] = [
  { role: "user", content: "do the task" },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "write_file", input: {} }],
  },
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
    const wrapped = withCheckpoints(
      fakeTools(() => "ok"),
      (context) => calls.push(context),
    );

    for (const name of ["write_file", "bash", "powershell"]) {
      await wrapped[name]?.execute?.({ path: "a.txt" }, execOpts());
    }

    expect(calls.map((call) => call.tool)).toEqual(["write_file", "bash", "powershell"]);
  });

  test("passes the tool's result through unchanged", async () => {
    const wrapped = withCheckpoints(
      fakeTools(() => ({ written: 3 })),
      () => {},
    );

    expect(await wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts())).toEqual({
      written: 3,
    });
  });

  test("re-throws the tool's error unchanged", async () => {
    const wrapped = withCheckpoints(
      fakeTools(() => {
        throw new Error("disk full");
      }),
      () => {},
    );

    expect(wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts())).rejects.toThrow(
      "disk full",
    );
  });

  test("hands the callback the toolCallId, the args, and messages.length - 1 as the rewind anchor", async () => {
    const calls: MutationContext[] = [];
    const wrapped = withCheckpoints(
      fakeTools(() => "ok"),
      (context) => calls.push(context),
    );

    await wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts("call-42"));

    expect(calls).toEqual([
      {
        tool: "write_file",
        toolCallId: "call-42",
        args: { path: "a.txt" },
        rewindTo: messages.length - 1,
      },
    ]);
  });

  test("onAfterMutation runs after the tool resolves, with the same context onBeforeMutation saw", async () => {
    const order: string[] = [];
    const wrapped = withCheckpoints(
      fakeTools(() => {
        order.push("execute");
        return "ok";
      }),
      () => order.push("before"),
      (context) => {
        order.push("after");
        expect(context).toEqual({
          tool: "write_file",
          toolCallId: "c1",
          args: { path: "a.txt" },
          rewindTo: messages.length - 1,
        });
      },
    );

    expect(await wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts())).toBe("ok");
    expect(order).toEqual(["before", "execute", "after"]);
  });

  test("onAfterMutation does not run when the tool call rejects", async () => {
    let afterCalled = false;
    const wrapped = withCheckpoints(
      fakeTools(() => {
        throw new Error("disk full");
      }),
      () => {},
      () => {
        afterCalled = true;
      },
    );

    await expect(wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts())).rejects.toThrow(
      "disk full",
    );
    expect(afterCalled).toBe(false);
  });

  test("omitting onAfterMutation leaves the tool's result passed through exactly as before", async () => {
    const wrapped = withCheckpoints(
      fakeTools(() => ({ written: 3 })),
      () => {},
    );

    expect(await wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts())).toEqual({
      written: 3,
    });
  });

  test("wraps a synchronous throw from a non-async execute as a rejected promise", async () => {
    const tools: ToolSet = {
      write_file: {
        ...fakeTools(() => "ok").write_file,
        execute: () => {
          throw new Error("disk full");
        },
      },
    } as ToolSet;
    const wrapped = withCheckpoints(tools, () => {});

    let result: unknown;
    expect(() => {
      result = wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts());
    }).not.toThrow();
    await expect(result).rejects.toThrow("disk full");
  });
});

describe("withMutationRecording", () => {
  test("runs onAfterMutation after the tool resolves, with no before-hook at all", async () => {
    const order: string[] = [];
    const wrapped = withMutationRecording(
      fakeTools(() => {
        order.push("execute");
        return "ok";
      }),
      () => order.push("after"),
    );

    expect(await wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts())).toBe("ok");
    expect(order).toEqual(["execute", "after"]);
  });

  test("does not run onAfterMutation when the tool call throws synchronously", async () => {
    let calls = 0;
    const wrapped = withMutationRecording(
      fakeTools(() => {
        throw new Error("disk full");
      }),
      () => {
        calls++;
      },
    );

    await expect(wrapped.write_file?.execute?.({ path: "a.txt" }, execOpts())).rejects.toThrow(
      "disk full",
    );
    expect(calls).toBe(0);
  });

  test("records every filesystem-mutating tool, not just write_file", async () => {
    const calls: MutationContext[] = [];
    const wrapped = withMutationRecording(
      fakeTools(() => "ok"),
      (context) => calls.push(context),
    );

    for (const name of ["write_file", "bash", "powershell"]) {
      await wrapped[name]?.execute?.({ path: "a.txt" }, execOpts());
    }

    expect(calls.map((call) => call.tool)).toEqual(["write_file", "bash", "powershell"]);
  });

  test("returns non-mutating tools by reference and never records them", async () => {
    const calls: MutationContext[] = [];
    const tools = fakeTools(() => "ok");
    const wrapped = withMutationRecording(tools, (context) => calls.push(context));

    for (const name of ["read_file", "edit", "grep", "glob"]) {
      expect(wrapped[name]).toBe(tools[name]);
      await wrapped[name]?.execute?.({ path: "a.txt" }, execOpts());
    }

    expect(calls).toEqual([]);
  });
});

describe.skipIf(!isGitAvailable())("withCheckpoints (snapshot precedes the write)", () => {
  let root: string;
  let gitDir: string;
  let workTree: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "seri-clause-d-test-"));
    gitDir = join(root, "git");
    workTree = join(root, "work");
    mkdirSync(workTree, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("checkpoint 1 holds the pre-write content, and the two calls leave two distinct trees to undo to", async () => {
    writeFileSync(join(workTree, "a.txt"), "before");
    initShadow(gitDir);

    const log: { toolCallId: string; tree: string }[] = [];
    const onBeforeMutation = (context: MutationContext): void => {
      log.push({ toolCallId: context.toolCallId, tree: writeTree(gitDir, workTree) });
    };

    const writing = withCheckpoints(
      fakeTools(() => writeFileSync(join(workTree, "a.txt"), "after")),
      onBeforeMutation,
    );
    await writing.write_file?.execute?.({ path: "a.txt" }, execOpts("c1"));

    const inert = withCheckpoints(
      fakeTools(() => "ok"),
      onBeforeMutation,
    );
    await inert.write_file?.execute?.({ path: "a.txt" }, execOpts("c2"));

    const catFile = spawnSync(
      "git",
      [`--git-dir=${gitDir}`, "cat-file", "-p", `${log[0]?.tree}:a.txt`],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    expect(catFile.stdout).toBe("before");
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("after");

    expect(log).toHaveLength(2);
    expect([...new Set(log.map((record) => record.tree))]).toHaveLength(2);
  }, 15_000);
});
