import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { checkPermission } from "../../src/gate/gate";
import { TODO_TOOL_NAME, withTodo } from "../../src/todo/tool";

const execOpts: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "test-call",
  messages: [],
  context: {},
};

const ITEMS = [
  { id: "a", content: "find compile flags", status: "done" as const },
  { id: "b", content: "add --minify", status: "in_progress" as const },
];

function run(args: unknown): Promise<unknown> {
  const tools = withTodo({});
  const definition = tools[TODO_TOOL_NAME] as {
    execute: (args: unknown, options: unknown) => unknown;
  };
  return Promise.resolve().then(() => definition.execute(args, execOpts));
}

describe("withTodo", () => {
  test("adds the todo key", () => {
    expect(Object.keys(withTodo({}))).toEqual([TODO_TOOL_NAME]);
    expect(Object.keys(withTodo({ read_file: {} as never }))).toEqual([
      "read_file",
      TODO_TOOL_NAME,
    ]);
  });

  test("execute round-trips items", async () => {
    expect(await run({ items: ITEMS })).toEqual(ITEMS);
  });

  test("duplicate ids fail", async () => {
    await expect(
      run({
        items: [
          { id: "a", content: "one", status: "pending" },
          { id: "a", content: "two", status: "done" },
        ],
      }),
    ).rejects.toThrow(/duplicate/i);
  });

  test("read-only allows todo", () => {
    expect(checkPermission(TODO_TOOL_NAME, "read-only")).toBe("allow");
  });
});
