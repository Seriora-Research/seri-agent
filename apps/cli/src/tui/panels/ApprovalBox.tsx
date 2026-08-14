// Extracted out of App.tsx (Stage A, cli-commands-to-tui feature-plan.md) verbatim: a pure move,
// no behavior change.

import { Box, Text, useInput } from "ink";
import { approvalPromptText } from "../../cli/output";
import type { ApprovalAnswer } from "../../loop/loop";
import { theme } from "../theme";

// approvalPromptText (cli/output.ts), not a hand-copied template: round 7 code review found this
// line written out twice (here and in makeApprovalPrompt's own rl.question call, cli.ts) — same
// escaping, same PERSISTABLE_TOOLS-gated "always" option, same [N]o-is-the-default framing, now
// from one shared function, so switching between the non-interactive and TUI paths is not also a
// UX change and the two can't drift apart the way toolResultLine/toolAllowedLine already prevent
// elsewhere. Captures a single keypress instead of readline's line-buffered question: y/a/n
// answer directly, Enter defaults to "no" (the bracketed capital in "[N]o"), and — matching
// makeApprovalPrompt's own "anything unrecognised is 'no'" rule, applied per-keystroke here
// instead of per-line — so does everything else, except Ctrl-D (quits, see onQuit below) and a
// bare Ctrl/Meta chord otherwise (Ctrl-C included, which App's own useInput below already routes
// to onCancel/signals.ts; answering "no" here too would just be a redundant second resolution of
// the same promise, not incorrect, but not this component's concern either).
export function ApprovalBox({
  pendingApproval,
  onAnswer,
  onQuit,
}: {
  pendingApproval: { toolName: string; args: unknown; offersAlways: boolean };
  onAnswer?: (answer: ApprovalAnswer) => void;
  onQuit?: () => void;
}) {
  const { toolName, args, offersAlways } = pendingApproval;

  useInput((input, key) => {
    // Round 7 code review: Ctrl-D used to do nothing while this component was mounted instead of
    // InputBox — quit() itself (cli.ts) denies the pending approval as part of the same graceful
    // sequence before proceeding, so this is the same onQuit InputBox's own Ctrl-D calls, not a
    // separate "deny just this one prompt" path.
    if (key.ctrl && input === "d") {
      onQuit?.();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.return) {
      onAnswer?.("no");
      return;
    }
    // Round 8 code review, finding 2: an arrow key, Backspace, Tab, Escape, or any other
    // non-printable key Ink recognises by name (not by text) reports `input === ""` from its own
    // parser (parse-keypress.js/use-input.js) — the same empty shape key.ctrl/key.meta above are
    // already excluded for. Without this, one of those fell straight into the "anything
    // unrecognised is 'no'" catch-all below, meant for actual mistyped TEXT, and silently denied
    // the approval on a stray navigation keypress — makeApprovalPrompt's own readline-based prompt
    // has no equivalent failure mode, since those keys only edit or no-op its line buffer.
    if (input.length === 0) return;
    const typed = input.toLowerCase();
    if (typed === "y") {
      onAnswer?.("once");
      return;
    }
    if (offersAlways && typed === "a") {
      onAnswer?.("always");
      return;
    }
    onAnswer?.("no");
  });

  return (
    <Box borderStyle="round" borderColor={theme.warning}>
      <Text color={theme.warning}>{approvalPromptText(toolName, args, offersAlways)}</Text>
    </Box>
  );
}
