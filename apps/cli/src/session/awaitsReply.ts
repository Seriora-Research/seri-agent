import type { ModelMessage } from "ai";

// Whether a resumed session still owes the user a reply — the gate cli.ts's `connectDispatch`
// applies before auto-starting a turn on a bare `--continue`/`--resume`. Not a plain
// `role === "user"` check: loop.ts's own non-`"no-tool-call"` done reasons ("aborted" — including
// a mid-tool-batch cancel, "max-iterations", "repeated-denials") never leave an assistant-text
// message as the last row — either nothing gets pushed for that turn at all (an abort before any
// tool call, so the last row is whatever it already was) or the tool-result row for the batch gets
// pushed before any of those reasons is yielded — so the session ends on "user" or "tool", exactly
// as unanswered as a bare user message: the model was cut off before giving its last word. The one
// state that's genuinely finished is an assistant message with no tool-call parts left in it; an
// assistant message that still carries an unresolved tool-call (only reachable if the process died
// between loop.ts pushing that message and running the calls it named) is treated the same as
// "owes a reply", since a resumed turn there is no worse than what an unconditional runTurn call
// already did.
export function awaitsReply(messages: ModelMessage[]): boolean {
  const last = messages.at(-1);
  if (last === undefined) return false;
  if (last.role !== "assistant") return true;
  return Array.isArray(last.content) && last.content.some((part) => part.type === "tool-call");
}
