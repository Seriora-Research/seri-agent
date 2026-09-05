import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  formatTodoLines,
  parseTodoList,
  TODO_TOOL_NAME,
  todoListFromMessages,
  type TodoItem,
} from "../../src/todo/list";

const COMPILE: TodoItem = { id: "a", content: "find compile flags", status: "done" };
const MINIFY: TodoItem = { id: "b", content: "add --minify", status: "in_progress" };
const SIZE: TodoItem = { id: "c", content: "add a size test", status: "pending" };

function assistantTodo(items: unknown, toolCallId = "c1"): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId,
        toolName: TODO_TOOL_NAME,
        input: { items },
      },
    ],
  };
}

function todoJsonResult(items: unknown, toolCallId = "c1"): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: TODO_TOOL_NAME,
        output: { type: "json", value: items },
      },
    ],
  };
}

function todoErrorResult(toolCallId = "c1"): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: TODO_TOOL_NAME,
        output: { type: "error-text", value: "threw" },
      },
    ],
  };
}

describe("parseTodoList", () => {
  test("rejects duplicate ids", () => {
    expect(
      parseTodoList({
        items: [
          { id: "a", content: "one", status: "pending" },
          { id: "a", content: "two", status: "done" },
        ],
      }),
    ).toBeUndefined();
  });

  test("rejects empty content", () => {
    expect(parseTodoList({ items: [{ id: "a", content: "", status: "pending" }] })).toBeUndefined();
  });

  test("rejects empty ids", () => {
    expect(parseTodoList({ items: [{ id: "", content: "x", status: "pending" }] })).toBeUndefined();
  });

  test("rejects unknown status", () => {
    expect(
      parseTodoList({ items: [{ id: "a", content: "x", status: "blocked" }] }),
    ).toBeUndefined();
  });

  test("empty array parses", () => {
    expect(parseTodoList({ items: [] })).toEqual([]);
    expect(parseTodoList([])).toEqual([]);
  });

  test("accepts a valid list as items or as a raw array", () => {
    const items = [COMPILE, MINIFY, SIZE];
    expect(parseTodoList({ items })).toEqual(items);
    expect(parseTodoList(items)).toEqual(items);
  });
});

describe("todoListFromMessages", () => {
  test("last successful result wins", () => {
    const messages: ModelMessage[] = [
      assistantTodo([COMPILE], "c1"),
      todoJsonResult([COMPILE], "c1"),
      assistantTodo([COMPILE, MINIFY], "c2"),
      todoJsonResult([COMPILE, MINIFY], "c2"),
    ];
    expect(todoListFromMessages(messages)).toEqual([COMPILE, MINIFY]);
  });

  test("slicing messages (rewind) drops later snapshots", () => {
    const messages: ModelMessage[] = [
      assistantTodo([COMPILE], "c1"),
      todoJsonResult([COMPILE], "c1"),
      assistantTodo([COMPILE, MINIFY, SIZE], "c2"),
      todoJsonResult([COMPILE, MINIFY, SIZE], "c2"),
    ];
    expect(todoListFromMessages(messages)).toEqual([COMPILE, MINIFY, SIZE]);
    expect(todoListFromMessages(messages.slice(0, 2))).toEqual([COMPILE]);
  });

  test("a thrown call does not replace the previous list", () => {
    const failed = [{ id: "x", content: "should not paint", status: "pending" as const }];
    const messages: ModelMessage[] = [
      assistantTodo([COMPILE], "c1"),
      todoJsonResult([COMPILE], "c1"),
      assistantTodo(failed, "c2"),
      todoErrorResult("c2"),
    ];
    expect(todoListFromMessages(messages)).toEqual([COMPILE]);
  });

  test("unrelated tool-results are ignored", () => {
    const messages: ModelMessage[] = [
      assistantTodo([COMPILE], "c1"),
      todoJsonResult([COMPILE], "c1"),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "read_file",
            output: { type: "json", value: "noise" },
          },
        ],
      },
    ];
    expect(todoListFromMessages(messages)).toEqual([COMPILE]);
  });

  test("an invalid snapshot is skipped and the previous list is kept", () => {
    const messages: ModelMessage[] = [
      assistantTodo([COMPILE, MINIFY], "c1"),
      todoJsonResult([COMPILE, MINIFY], "c1"),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: TODO_TOOL_NAME,
            output: {
              type: "json",
              value: [
                { id: "a", content: "one", status: "pending" },
                { id: "a", content: "dup", status: "done" },
              ],
            },
          },
        ],
      },
    ];
    expect(todoListFromMessages(messages)).toEqual([COMPILE, MINIFY]);
  });

  test("missing or empty messages yield an empty list", () => {
    expect(todoListFromMessages([])).toEqual([]);
    expect(todoListFromMessages([{ role: "user", content: "hi" }])).toEqual([]);
  });
});

describe("formatTodoLines", () => {
  test("matches the issue example", () => {
    expect(formatTodoLines([COMPILE, MINIFY, SIZE])).toEqual([
      "1. find compile flags (done)",
      "2. add --minify (in progress)",
      "3. add a size test (pending)",
    ]);
  });
});
