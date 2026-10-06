import type { ModelMessage } from "ai";

function cancelledReason(toolName: string): string {
  return `Tool "${toolName}" was cancelled by the user before it completed.`;
}

export function closeUnansweredToolCalls(messages: ModelMessage[]): boolean {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && typeof part.toolCallId === "string") {
        answered.add(part.toolCallId);
      }
    }
  }
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const unanswered: { toolCallId: string; toolName: string }[] = [];
    for (const part of message.content) {
      if (
        part.type === "tool-call" &&
        typeof part.toolCallId === "string" &&
        typeof part.toolName === "string" &&
        !answered.has(part.toolCallId)
      ) {
        unanswered.push({ toolCallId: part.toolCallId, toolName: part.toolName });
      }
    }
    if (unanswered.length === 0) continue;
    const rows = unanswered.map((call) => ({
      type: "tool-result" as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: {
        type: "execution-denied" as const,
        reason: cancelledReason(call.toolName),
      },
    }));
    const next = messages[i + 1];
    if (next !== undefined && next.role === "tool" && Array.isArray(next.content)) {
      next.content.push(...rows);
    } else {
      messages.splice(i + 1, 0, { role: "tool", content: rows });
      i += 1;
    }
    for (const call of unanswered) answered.add(call.toolCallId);
    changed = true;
  }
  return changed;
}
