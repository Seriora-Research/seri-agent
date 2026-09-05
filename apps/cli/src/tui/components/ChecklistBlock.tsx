/** @jsxImportSource @opentui/react */
import { formatTodoLines, type TodoList } from "../../todo/list";
import { theme } from "../theme/theme";

export function ChecklistBlock({ items }: { items: TodoList }) {
  if (items.length === 0) return null;
  return (
    <box flexDirection="column">
      {formatTodoLines(items).map((line, index) => (
        <text key={items[index]?.id ?? line} fg={theme.muted} truncate wrapMode="none">
          {line}
        </text>
      ))}
    </box>
  );
}
