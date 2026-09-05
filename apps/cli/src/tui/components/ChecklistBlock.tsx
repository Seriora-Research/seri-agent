/** @jsxImportSource @opentui/react */
// Last successful parent `todo` snapshot, drawn between the transcript and the input box.
// Nothing renders at depth zero — not an empty frame, not a header. The block only costs rows
// when there is something in it, which matters because every row here comes out of the
// transcript's own (app.tsx's transcript box is `flexGrow`, so rows added below it shrink the
// scrollbox). No keyboard: this is a paint of the model's list, not a surface the user edits.
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
