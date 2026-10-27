import type { ModelMessage } from "ai";

export function isIncompleteToolCallInput(input: unknown): boolean {
  return typeof input !== "object" || input === null || Array.isArray(input);
}

export function dropIncompleteToolCalls(messages: ModelMessage[], startIndex = 0): boolean {
  let changed = false;
  const begin = Math.max(0, startIndex);
  for (let i = messages.length - 1; i >= begin; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const incomplete = new Set<string>();
    for (const part of message.content) {
      if (
        part.type === "tool-call" &&
        typeof part.toolCallId === "string" &&
        isIncompleteToolCallInput(part.input)
      ) {
        incomplete.add(part.toolCallId);
      }
    }
    if (incomplete.size === 0) continue;

    const next = messages[i + 1];
    if (next !== undefined && next.role === "tool" && Array.isArray(next.content)) {
      const results = next.content.filter(
        (part) => part.type !== "tool-result" || !incomplete.has(part.toolCallId),
      );
      if (results.length !== next.content.length) {
        changed = true;
        if (results.length === 0) messages.splice(i + 1, 1);
        else next.content = results;
      }
    }

    const content = message.content.filter(
      (part) => part.type !== "tool-call" || !incomplete.has(part.toolCallId),
    );
    if (content.length === message.content.length) continue;
    changed = true;
    if (content.length === 0) messages.splice(i, 1);
    else message.content = content;
  }
  return changed;
}
