import type { ModelMessage } from "ai";















export function awaitsReply(messages: ModelMessage[]): boolean {
  const last = messages.at(-1);
  if (last === undefined) return false;
  if (last.role !== "assistant") return true;
  return Array.isArray(last.content) && last.content.some((part) => part.type === "tool-call");
}
