import type { ModelMessage } from "ai";

export const TODO_TOOL_NAME = "todo";

export const TODO_STATUSES = ["pending", "in_progress", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
};

export type TodoList = TodoItem[];

const STATUS_SET: ReadonlySet<string> = new Set(TODO_STATUSES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseTodoItem(value: unknown): TodoItem | undefined {
  if (!isRecord(value)) return undefined;
  const { id, content, status } = value;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof content !== "string" || content.length === 0) return undefined;
  if (typeof status !== "string" || !STATUS_SET.has(status)) return undefined;
  return { id, content, status: status as TodoStatus };
}

function parseItems(values: readonly unknown[]): TodoList | undefined {
  const items: TodoItem[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = parseTodoItem(value);
    if (item === undefined) return undefined;
    if (seen.has(item.id)) return undefined;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

// Accepts the tool-call input `{ items }` and the execute result (the items array).
export function parseTodoList(input: unknown): TodoList | undefined {
  if (Array.isArray(input)) return parseItems(input);
  if (!isRecord(input) || !Array.isArray(input.items)) return undefined;
  return parseItems(input.items);
}

function jsonToolResultValue(part: unknown): unknown {
  if (part === null || typeof part !== "object" || Array.isArray(part)) return undefined;
  const rec = part as { type?: unknown; toolName?: unknown; output?: unknown };
  if (rec.type !== "tool-result" || rec.toolName !== TODO_TOOL_NAME) return undefined;
  const output = rec.output;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const payload = output as { type?: unknown; value?: unknown };
  if (payload.type !== "json") return undefined;
  return payload.value;
}

// Successful `todo` tool-result JSON, not tool-call input. A denied or thrown call still stores a
// tool-call whose args parse; using those would paint a list that never landed.
export function todoListFromMessages(messages: readonly ModelMessage[]): TodoList {
  let list: TodoList = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const parsed = parseTodoList(jsonToolResultValue(part));
      if (parsed !== undefined) list = parsed;
    }
  }
  return list;
}

export function formatTodoLine(index: number, item: TodoItem): string {
  const status = item.status === "in_progress" ? "in progress" : item.status;
  return `${index}. ${item.content} (${status})`;
}

export function formatTodoLines(list: TodoList): string[] {
  return list.map((item, i) => formatTodoLine(i + 1, item));
}
