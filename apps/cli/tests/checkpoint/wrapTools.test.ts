import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type ModelMessage, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { initShadow, isGitAvailable, writeTree } from "../../src/checkpoint/shadowGit";
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

// success_check (d): the snapshot must be proven to happen BEFORE the tool wrote, not after.
// opencode's own test suite records this as "a real bug" in their design — the SDK executes the
// tool before their start-step handler can snapshot, so both the before and after snapshots carry
// the same tree hash and the diff comes back empty. A checkpoint feature can be fully green and
// completely empty, so this test is the one that has to be seen failing.
//
// Neither assertion depends on timing or on how slowly the tool returns, which is precisely what
// opencode's race destroyed: the fake tool below writes synchronously and returns immediately.
describe.skipIf(!isGitAvailable())("withCheckpoints (clause d)", () => {
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

  test(
    "checkpoint 1 holds the pre-write content, and the two calls leave two distinct trees to undo to",
    async () => {
      writeFileSync(join(workTree, "a.txt"), "before");
      initShadow(gitDir);

      // A checkpointer with the same shape as the real one: snapshot on every mutating call, and
      // dedupe by tree so a call that changed nothing is not offered as somewhere to undo to.
      const log: { toolCallId: string; tree: string }[] = [];
      const onBeforeMutation = (context: MutationContext): void => {
        log.push({ toolCallId: context.toolCallId, tree: writeTree(gitDir, workTree) });
      };

      const writing = withCheckpoints(fakeTools(() => writeFileSync(join(workTree, "a.txt"), "after")), onBeforeMutation);
      await writing.write_file?.execute?.({ path: "a.txt" }, execOpts("c1"));

      const inert = withCheckpoints(fakeTools(() => "ok"), onBeforeMutation);
      await inert.write_file?.execute?.({ path: "a.txt" }, execOpts("c2"));

      // (i) content: the tree checkpoint 1 recorded still holds "before" while the disk holds
      // "after". Read with plain git rather than through our own module, so the evidence does not
      // depend on the code under test. Under a post-hoc or start-step design this reads "after".
      const catFile = spawnSync("git", [`--git-dir=${gitDir}`, "cat-file", "-p", `${log[0]?.tree}:a.txt`], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(catFile.stdout).toBe("before");
      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("after");

      // (ii) count: two calls, two distinct trees, so `/undo` has two places to go. Under a
      // post-hoc design both snapshots see "after", the trees are identical, and the dedupe
      // collapses them into a single undo target.
      expect(log).toHaveLength(2);
      expect([...new Set(log.map((record) => record.tree))]).toHaveLength(2);
    },
    15_000,
  );
});
