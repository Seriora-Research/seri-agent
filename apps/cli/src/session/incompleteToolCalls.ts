import type { ModelMessage } from "ai";

export function isIncompleteToolCallInput(input: unknown): boolean {
  return typeof input !== "object" || input === null || Array.isArray(input);
}

export function dropIncompleteToolCalls(messages: ModelMessage[]): boolean {
  const incomplete = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part.type === "tool-call" &&
        typeof part.toolCallId === "string" &&
        isIncompleteToolCallInput(part.input)
      ) {
        incomplete.add(part.toolCallId);
      }
    }
  }
  if (incomplete.size === 0) return false;

  let changed = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content = message.content.filter(
        (part) => part.type !== "tool-call" || !incomplete.has(part.toolCallId),
      );
      if (content.length === message.content.length) continue;
      changed = true;
      if (content.length === 0) messages.splice(i, 1);
      else message.content = content;
    } else if (message.role === "tool") {
      const content = message.content.filter(
        (part) => part.type !== "tool-result" || !incomplete.has(part.toolCallId),
      );
      if (content.length === message.content.length) continue;
      changed = true;
      if (content.length === 0) messages.splice(i, 1);
      else message.content = content;
    }
  }
  return changed;
}
