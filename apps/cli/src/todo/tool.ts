import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import {
  parseTodoList,
  TODO_STATUSES,
  TODO_TOOL_NAME,
  type TodoList,
} from "./list";

export { TODO_TOOL_NAME };

const DESCRIPTION =
  `Replace the whole visible checklist for this turn. Use it for multi-step work so the ` +
  `user can see what is pending, in progress, or done. Send the complete list on every ` +
  `call; keep item ids stable across calls. An empty items array clears the list.`;

const todoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(TODO_STATUSES),
});

const todoInputSchema = z
  .object({
    items: z.array(todoItemSchema),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const item of value.items) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate todo id "${item.id}"`,
          path: ["items"],
        });
        return;
      }
      seen.add(item.id);
    }
  });

export function withTodo(tools: ToolSet): ToolSet {
  return {
    ...tools,
    [TODO_TOOL_NAME]: tool({
      description: DESCRIPTION,
      inputSchema: todoInputSchema,
      execute: ({ items }): TodoList => {
        const parsed = parseTodoList({ items });
        if (parsed === undefined) {
          throw new Error(
            "todo items must have unique non-empty ids, non-empty content, and no duplicate ids",
          );
        }
        return parsed;
      },
    }),
  };
}
